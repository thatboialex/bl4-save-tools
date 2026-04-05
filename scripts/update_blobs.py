#!/usr/bin/env python3
# Update compressed blob constants in blobs.js with new compressed data

import argparse
import os
import re
import sys
import yaml
import zlib
import base64


def update_blob_constant(blobs_js_path, constant_name, compressed_value):
    """
    Update a constant in blobs.js with a new compressed string value.
    
    Args:
        blobs_js_path: Path to blobs.js file
        constant_name: Name of the constant (e.g., 'COLLECTIBLES_COMPRESSED')
        compressed_value: New compressed base64 string value
    """
    if not os.path.exists(blobs_js_path):
        print(f"Error: {blobs_js_path} not found", file=sys.stderr)
        return False
    
    with open(blobs_js_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Pattern to match: const CONSTANT_NAME = 'value';
    # Handle multiline string values
    pattern = rf"(const\s+{re.escape(constant_name)}\s*=\s*)'([^']*)';"
    
    if not re.search(pattern, content):
        print(f"Error: Constant '{constant_name}' not found in {blobs_js_path}", file=sys.stderr)
        return False
    
    # Replace the value
    new_content = re.sub(
        pattern,
        rf"\1'{compressed_value}';",
        content
    )
    
    if new_content == content:
        print(f"No changes needed for {constant_name}")
        return True
    
    # Write back
    with open(blobs_js_path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    
    print(f"✓ Updated {constant_name} in {blobs_js_path}")
    return True


def compress_yaml_file(yaml_file):
    """Compress a YAML file to base64 string."""
    with open(yaml_file, 'r', encoding='utf-8') as f:
        data = yaml.safe_load(f)
    yaml_str = yaml.safe_dump(data, allow_unicode=True, sort_keys=False)
    compressed = zlib.compress(yaml_str.encode('utf-8'))
    return base64.b64encode(compressed).decode('ascii')


def compress_text_list(text_file):
    """Compress a text file (comma-separated or newline-separated) to base64 string."""
    with open(text_file, 'r', encoding='utf-8') as f:
        content = f.read().strip()
    
    # Check if it's already comma-separated or newline-separated
    if '\n' in content and ',' not in content:
        # Newline-separated list
        items = [line.strip() for line in content.split('\n') if line.strip()]
        joined = ','.join(items)
    else:
        # Assume already comma-separated or single item
        joined = content
    
    compressed = zlib.compress(joined.encode('utf-8'))
    return base64.b64encode(compressed).decode('ascii')


def read_compressed_file(compressed_file):
    """Read the compressed string from a file."""
    with open(compressed_file, 'r', encoding='utf-8') as f:
        return f.read().strip()


def main():
    parser = argparse.ArgumentParser(
        description="Update compressed blob constants in blobs.js",
        epilog="""
Examples:
  # From pre-compressed file
  %(prog)s -c COLLECTIBLES_COMPRESSED -f collectibles_compressed.txt
  
  # From YAML file (will compress automatically)
  %(prog)s -c COLLECTIBLES_COMPRESSED --yaml collectibles.yaml
  
  # From text list file (will compress automatically)
  %(prog)s -c LOCATIONS_COMPRESSED --text locations.txt
        """,
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('-b', '--blobs-js', default='../assets/blobs.js', help='Path to blobs.js file (default: ../assets/blobs.js)')
    parser.add_argument('-c', '--constant', required=True, help='Constant name to update (e.g., COLLECTIBLES_COMPRESSED)')
    parser.add_argument('--save-compressed', action='store_true', help='Save the compressed string to a .txt file alongside the input file')

    # Input source options (mutually exclusive)
    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument('-f', '--file', help='Path to pre-compressed text file')
    input_group.add_argument('--yaml', help='Path to YAML file (will be compressed automatically)')
    input_group.add_argument('--text', help='Path to text list file (will be compressed automatically)')

    args = parser.parse_args()

    # Resolve relative paths from script directory
    script_dir = os.path.dirname(os.path.abspath(__file__))
    blobs_js_path = os.path.normpath(os.path.join(script_dir, args.blobs_js))

    # Determine input file and compression method
    input_file = None
    if args.file:
        if not os.path.exists(args.file):
            print(f"Error: File '{args.file}' not found", file=sys.stderr)
            sys.exit(1)
        input_file = args.file
        compressed_value = read_compressed_file(args.file)
        print(f"Reading pre-compressed data from {args.file}")
    elif args.yaml:
        if not os.path.exists(args.yaml):
            print(f"Error: YAML file '{args.yaml}' not found", file=sys.stderr)
            sys.exit(1)
        input_file = args.yaml
        print(f"Compressing YAML file {args.yaml}...")
        compressed_value = compress_yaml_file(args.yaml)
    elif args.text:
        if not os.path.exists(args.text):
            print(f"Error: Text file '{args.text}' not found", file=sys.stderr)
            sys.exit(1)
        input_file = args.text
        print(f"Compressing text list {args.text}...")
        compressed_value = compress_text_list(args.text)

    if not compressed_value:
        print(f"Error: Compressed value is empty", file=sys.stderr)
        sys.exit(1)

    if args.save_compressed and input_file:
        base, _ = os.path.splitext(os.path.abspath(input_file))
        output_path = base + "_compressed.txt"
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(compressed_value)
        print(f"✓ Saved compressed string to {output_path}")

    success = update_blob_constant(blobs_js_path, args.constant, compressed_value)

    if not success:
        sys.exit(1)


if __name__ == "__main__":
    main()
