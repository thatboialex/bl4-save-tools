#!/usr/bin/env python3
"""
Extract location and reward lists from Borderlands 4 YAML save files.

Extracts discovered locations or unique rewards, merges with existing data,
and outputs both human-readable text files and compressed strings for JavaScript.

Examples:
    Extract locations:
        python extract_lists.py -i ../../profile.yaml -o ../data/locations.txt -c
    
    Extract rewards:
        python extract_lists.py -i ../../1.yaml -o ../data/rewards.txt -c -r
    
    Extract and update blobs.js:
        python extract_lists.py -i ../../profile.yaml -o ../data/locations.txt -c \
            -b ../assets/blobs.js --blob-const LOCATIONS_COMPRESSED
"""

import argparse
import os
import yaml
import re
import zlib
import base64

try:
    from update_blobs import update_blob_constant
    HAS_UPDATE_BLOBS = True
except ImportError:
    HAS_UPDATE_BLOBS = False


def unknown_tag(loader, tag_suffix, node):
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node)
    elif isinstance(node, yaml.MappingNode):
        return loader.construct_mapping(node)
    else:
        return loader.construct_scalar(node)


yaml.SafeLoader.add_multi_constructor('!', unknown_tag)


def extract_and_merge(input_yaml, output_text, compressed_output, extract_func, blob_constant=None, blobs_js_path=None):
    with open(input_yaml, 'r', encoding='utf-8') as f:
        data = yaml.safe_load(f)

    # Extract new entries using the provided function
    new_entries = set(extract_func(data))

    # Read existing entries from output file, if it exists
    existing_entries = set()
    if os.path.exists(output_text):
        with open(output_text, 'r', encoding='utf-8') as out:
            for line in out:
                line = line.strip()
                if line:
                    existing_entries.add(line)

    # Merge and deduplicate
    initial_count = len(existing_entries)
    all_entries = existing_entries | new_entries
    added_count = len(all_entries) - initial_count

    # Sort for consistency
    all_entries = sorted(all_entries)

    print(f"Extracted {len(new_entries)} entries from YAML.")
    if added_count == 0:
        print("No new entries to add. Exiting.")
        return
    print(f"Adding {added_count} new entries.")

    # Write merged entries to txt file (one per line)
    with open(output_text, 'w', encoding='utf-8') as out:
        for entry in all_entries:
            out.write(entry + '\n')

    # Join, compress, and encode for JS
    joined = ','.join(all_entries)
    compressed = zlib.compress(joined.encode('utf-8'))
    b64 = base64.b64encode(compressed).decode('ascii')

    if not compressed_output:
        compressed_output = output_text.rsplit('.', 1)[0] + '_compressed.txt'
    with open(compressed_output, 'w', encoding='utf-8') as out:
        out.write(b64)

    print(f"Merged output written to {output_text}")
    print(f"Compressed string written to {compressed_output}")
    
    # Optionally update blobs.js
    if blob_constant and blobs_js_path and HAS_UPDATE_BLOBS:
        update_blob_constant(blobs_js_path, blob_constant, b64)


def extract_locations_from_yaml(data):
    dlblob = data['domains']['local']['gbx_discovery_pg_shared']['dlblob']
    locations = re.split(r':\d:', dlblob)
    return [loc for loc in locations if loc]


def extract_rewards_from_yaml(data):
    return data.get('state', {}).get('unique_rewards', [])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Extract discovered locations or unique rewards from a YAML save file, then export as raw and compressed files",
        epilog="""
Examples:
  # Extract locations (default)
  %(prog)s -i ../../saves/1.yaml -o ../data/locations.txt -c
  
  # Extract unique rewards
  %(prog)s -i ../../saves/1.yaml -o ../data/rewards.txt -c -r
  
  # Extract and auto-update blobs.js
  %(prog)s -i ../../saves/1.yaml -o ../data/locations.txt -c \
      -b ../assets/blobs.js --blob-const LOCATIONS_COMPRESSED
        """,
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('-i', '--inputyaml', help='Input YAML file', required=True)
    parser.add_argument('-o', '--outputtext', help='Output entries to txt file. Will merge with existing.', required=True)
    parser.add_argument('-c', '--compressed', help='Output compressed base64 txt file', required=False)
    parser.add_argument('-r', '--rewards', action='store_true', help='Extract unique rewards instead of locations')
    parser.add_argument('-b', '--blobs-js', help='Path to blobs.js file to update')
    parser.add_argument('--blob-const', help='Blob constant name (e.g., LOCATIONS_COMPRESSED)')
    args = parser.parse_args()

    if args.rewards:
        extract_and_merge(
            args.inputyaml,
            args.outputtext,
            args.compressed,
            extract_rewards_from_yaml,
            blob_constant='REWARDS_COMPRESSED' if args.blobs_js else None,
            blobs_js_path=args.blobs_js
        )
    else:
        extract_and_merge(
            args.inputyaml,
            args.outputtext,
            args.compressed,
            extract_locations_from_yaml,
            blob_constant='LOCATIONS_COMPRESSED' if args.blobs_js else None,
            blobs_js_path=args.blobs_js
        )
