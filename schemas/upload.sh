#!/bin/bash

DIR_NAME=$(dirname "$0")

for file in "$DIR_NAME"/*.schema.yaml; do
    echo "Uploading $file to R2 bucket..."
    wrangler r2 object put sws/shared/schemas/"$(basename "$file")" --file "$file" --remote
done