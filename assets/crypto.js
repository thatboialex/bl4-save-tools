/**
 * Cryptography and compression module for .sav files.
 * Implements the game's save file format encryption and compression:
 * - AES-ECB encryption with user-specific key derivation
 * - PKCS7 padding
 * - zlib compression
 * - Checksum validation
 */

/**
 * Converts a string to UTF-16 little-endian byte array.
 * @param {string} str - The input string to convert
 * @returns {number[]} Array of bytes representing the string in UTF-16LE
 */
function utf16leBytes(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    bytes.push(code & 0xff, (code >> 8) & 0xff);
  }
  return bytes;
}

/**
 * Derives an encryption key from the user's platform ID.
 * Supports Steam IDs (17+ digit numbers) and Epic/PSN IDs (strings).
 * @param {string} userID - The user's Steam ID, Epic ID, or PSN Account ID
 * @returns {number[]} 32-byte encryption key
 */
function deriveKey(userID) {
  const BASE_KEY = [
    0x35, 0xec, 0x33, 0x77, 0xf3, 0x5d, 0xb0, 0xea, 0xbe, 0x6b, 0x83, 0x11, 0x54, 0x03, 0xeb, 0xfb,
    0x27, 0x25, 0x64, 0x2e, 0xd5, 0x49, 0x06, 0x29, 0x05, 0x78, 0xbd, 0x60, 0xba, 0x4a, 0xa7, 0x87,
  ];
  let k = BASE_KEY.slice();

  let uid_bytes;
  if (/^\d{17,}$/.test(userID)) {
    // Steam ID / PSN Account ID: treat as 8-byte little-endian integer
    let sid = BigInt(userID);
    uid_bytes = [];
    for (let i = 0; i < 8; i++) {
      uid_bytes.push(Number(sid & 0xffn));
      sid >>= 8n;
    }
  } else {
    // Epic ID: UTF-16LE bytes
    uid_bytes = utf16leBytes(userID);
  }

  for (let i = 0; i < Math.min(k.length, uid_bytes.length); i++) {
    k[i] ^= uid_bytes[i];
  }
  return k;
}

/**
 * Removes PKCS7 padding from a buffer.
 * @param {Uint8Array} buf - The padded buffer
 * @returns {Uint8Array} The unpadded buffer
 */
function pkcs7Unpad(buf) {
  const pad = buf[buf.length - 1];
  for (let i = 1; i <= pad; i++) {
    if (buf[buf.length - i] !== pad) {
      console.warn('PKCS7 unpad failed, returning padded data');
      return buf;
    }
  }
  return buf.slice(0, buf.length - pad);
}

function pkcs7Pad(buf, blockSize = 16) {
  const pad = blockSize - (buf.length % blockSize);
  const out = new Uint8Array(buf.length + pad);
  out.set(buf);
  out.fill(pad, buf.length);
  return out;
}

function uint8ArrayToWordArray(u8arr) {
  var words = [],
    i = 0,
    len = u8arr.length;
  for (; i < len; i += 4) {
    words.push((u8arr[i] << 24) | (u8arr[i + 1] << 16) | (u8arr[i + 2] << 8) | u8arr[i + 3]);
  }
  return CryptoJS.lib.WordArray.create(words, len);
}

/**
 * Detects whether a Uint8Array is Base64-encoded text.
 * Returns the decoded binary Uint8Array if it is, or null otherwise.
 */
function tryBase64Decode(bytes) {
  const text = new TextDecoder('ascii', { fatal: false }).decode(bytes).trim();
  if (!/^[A-Za-z0-9+/\r\n]+=*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/\s/g, ''));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch (e) {
    return null;
  }
}

function aesEcbDecrypt(cipherBytes, keyBytes) {
  const keyWordArray = uint8ArrayToWordArray(new Uint8Array(keyBytes));
  const ciphWordArray = uint8ArrayToWordArray(cipherBytes);
  const decrypted = CryptoJS.AES.decrypt({ ciphertext: ciphWordArray }, keyWordArray, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.NoPadding,
  });
  let pt = new Uint8Array(decrypted.words.length * 4);
  for (let i = 0; i < decrypted.words.length; i++) {
    pt.set(
      [
        (decrypted.words[i] >> 24) & 0xff,
        (decrypted.words[i] >> 16) & 0xff,
        (decrypted.words[i] >> 8) & 0xff,
        decrypted.words[i] & 0xff,
      ],
      i * 4
    );
  }
  return pt.slice(0, cipherBytes.length);
}

/**
 * Attempts zlib inflate, trying multiple start offsets and footer trims.
 * When userID is provided, only tries offset 0 with trims [4, 8] (PC format).
 * Without userID, scans for zlib magic byte and tries trims [0, 4, 8].
 */
function tryInflate(data, userID) {
  const VALID_ZLIB_SECOND = new Set([0x01, 0x5e, 0x9c, 0xda]);
  const starts = userID ? [0] : (() => {
    const offsets = [];
    const scanLimit = Math.min(data.length - 1, 256);
    for (let i = 0; i < scanLimit; i++) {
      if (data[i] === 0x78 && VALID_ZLIB_SECOND.has(data[i + 1])) offsets.push(i);
    }
    if (offsets.length === 0) offsets.push(0);
    return offsets;
  })();

  const trimOptions = userID ? [4, 8] : [0, 4, 8];

  for (let start of starts) {
    for (let trim of trimOptions) {
      try {
        const slice = data.slice(start, trim === 0 ? undefined : data.length - trim);
        if (slice[0] !== 0x78) continue;
        return pako.inflate(slice);
      } catch (e) {
        // Try next combination
      }
    }
  }
  return null;
}

// Tracks whether the imported file was Base64-encoded so export can mirror the format.
let importedAsBase64 = false;

/**
 * Decrypts a .sav file and converts it to YAML.
 * Handles PC saves (AES-ECB + zlib), PS5 saves (Base64 + AES-ECB + zlib),
 * and pre-decrypted saves (zlib only or plain YAML).
 */
function decryptSav(fileArrayBuffer, normalize = true) {
  const userID = document.getElementById('userIdInput').value.trim();
  let ciph = new Uint8Array(fileArrayBuffer);

  // Strip Base64 wrapper if present (PS5 decryption tools output Base64-encoded saves)
  const b64decoded = tryBase64Decode(ciph);
  importedAsBase64 = b64decoded !== null;
  if (importedAsBase64) {
    console.debug('Detected Base64-encoded save, stripping wrapper');
    ciph = b64decoded;
  }

  let inflated = null;

  if (userID) {
    localStorage.setItem('bl4_previous_userid', userID);
    let pt = aesEcbDecrypt(ciph, deriveKey(userID));
    pt = pkcs7Unpad(pt);
    inflated = tryInflate(pt, userID);
  } else {
    // No user ID: try zlib directly (works if AES layer is already removed)
    inflated = tryInflate(ciph, null);

  // Try zlib inflate. PC saves have 8 bytes of footer (adler32 + uncompressed length).
  // Pre-decrypted saves may have a variable-length header before the zlib stream
  // and 0, 4, or 8 bytes of footer after it.
  let inflated = null;
  let trimUsed = null;

  // Find all candidate zlib stream start offsets (0x78 followed by a valid CMF flag byte)
  const VALID_ZLIB_SECOND = new Set([0x01, 0x5e, 0x9c, 0xda]);
  const starts = userID ? [0] : (() => {
    const offsets = [];
    const scanLimit = Math.min(pt.length - 1, 256);
    for (let i = 0; i < scanLimit; i++) {
      if (pt[i] === 0x78 && VALID_ZLIB_SECOND.has(pt[i + 1])) offsets.push(i);
    }
    if (offsets.length === 0) offsets.push(0); // fallback: try from offset 0 anyway
    return offsets;
  })();

  const trimOptions = userID ? [4, 8] : [0, 4, 8];

  outer: for (let start of starts) {
    for (let trim of trimOptions) {
      try {
        const slice = pt.slice(start, trim === 0 ? undefined : pt.length - trim);
        if (slice[0] !== 0x78) continue;
        inflated = pako.inflate(slice);
        trimUsed = trim;
        break outer;
      } catch (e) {
        // Try next combination
      }
    }
  }

  // Last resort when no user ID: try interpreting the raw bytes as plain UTF-8 YAML
  if (!inflated && !userID) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(pt);
      if (normalize) return normalizeYaml(new TextEncoder().encode(text));
      return text;
    } catch (e) {
      // Not valid UTF-8
    }
  }

  if (!inflated) {
    if (!userID) {
      alert(
        'Failed to load save.\n\n' +
        'Your save is still encrypted — the PS5 decryption tool only removed the console layer.\n\n' +
        'Enter your PSN Account ID (the 19-digit number, NOT your username) in the Account ID field and try again.\n\n' +
        'Find it at: PS5 Settings → Account Management → Account Information → Sign-In ID, or check your PS5 save folder path.'
      );
    } else {
      alert('Zlib decompress failed. Wrong user ID or file format?');
    }
    return;
  }

  console.debug('Successfully decompressed save');
  if (normalize) {
    return normalizeYaml(inflated);
  }
  return new TextDecoder().decode(inflated);
}

// Encrypt (or re-pack) YAML to .sav
function encryptSav() {
  const file = document.getElementById('fileInput').files[0];
  const userID = document.getElementById('userIdInput').value.trim();
  if (!file) {
    alert('Please select a file first.');
    return;
  }

  if (userID) {
    localStorage.setItem('bl4_previous_userid', userID);
  }

  const yamlBytes = new TextEncoder().encode(editor.getValue());

  // Compress zlib
  const comp = pako.deflate(yamlBytes, { level: 9 });

  // Compute adler32
  function adler32(buf) {
    let a = 1,
      b = 0;
    for (let i = 0; i < buf.length; i++) {
      a = (a + buf[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }
  const adler = adler32(yamlBytes);
  const uncompressedLen = yamlBytes.length;

  // Append adler32 and uncompressed length (both little-endian, 4 bytes each)
  const packed = new Uint8Array(comp.length + 8);
  packed.set(comp, 0);
  packed[comp.length + 0] = adler & 0xff;
  packed[comp.length + 1] = (adler >> 8) & 0xff;
  packed[comp.length + 2] = (adler >> 16) & 0xff;
  packed[comp.length + 3] = (adler >> 24) & 0xff;
  packed[comp.length + 4] = uncompressedLen & 0xff;
  packed[comp.length + 5] = (uncompressedLen >> 8) & 0xff;
  packed[comp.length + 6] = (uncompressedLen >> 16) & 0xff;
  packed[comp.length + 7] = (uncompressedLen >> 24) & 0xff;

  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const exportFilename = `${importFilename}_${timestamp.slice(0, 8)}_${timestamp.slice(8)}.sav`;

  let outBytes;

  if (userID) {
    // PC / PS5: PKCS7 pad then AES-ECB encrypt
    const pt_padded = pkcs7Pad(packed);
    const keyBytes = deriveKey(userID);
    const keyWordArray = uint8ArrayToWordArray(new Uint8Array(keyBytes));

    const ptWordArray = CryptoJS.lib.WordArray.create(pt_padded);
    const encrypted = CryptoJS.AES.encrypt(ptWordArray, keyWordArray, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.NoPadding,
    });
    outBytes = new Uint8Array(encrypted.ciphertext.words.length * 4);
    for (let i = 0; i < encrypted.ciphertext.words.length; i++) {
      outBytes.set(
        [
          (encrypted.ciphertext.words[i] >> 24) & 0xff,
          (encrypted.ciphertext.words[i] >> 16) & 0xff,
          (encrypted.ciphertext.words[i] >> 8) & 0xff,
          encrypted.ciphertext.words[i] & 0xff,
        ],
        i * 4
      );
    }
  } else {
    // No user ID: output without AES encryption (pre-decrypted format)
    outBytes = packed;
  }

  // If the original file was Base64-encoded, re-encode the output to match
  let blobData;
  if (importedAsBase64) {
    let binary = '';
    for (let i = 0; i < outBytes.length; i++) binary += String.fromCharCode(outBytes[i]);
    blobData = btoa(binary);
  } else {
    blobData = outBytes;
  }

  const blob = new Blob([blobData], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exportFilename;
  a.click();
  URL.revokeObjectURL(url);
}
