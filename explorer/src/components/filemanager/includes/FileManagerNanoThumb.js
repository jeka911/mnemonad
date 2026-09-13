/**
 * FileManagerNanoThumb - Ultra-compact thumbnail generator
 * Generates < 1KB thumbnails with stripped PNG headers, similar to Telegram's approach
 */
export default class FileManagerNanoThumb {
    /**
     * Generates an ultra-compact nano thumbnail (< 1KB) with PNG headers stripped.
     * @param {HTMLImageElement|HTMLVideoElement} element - The media element
     * @param {number} [size=10] - Size of the nano thumbnail (width/height)
     * @returns {Promise<Uint8Array>} 
     */
    static async generate(element, size = 10) {
        const width = element.naturalWidth || element.videoWidth;
        const height = element.naturalHeight || element.videoHeight;

        // Create tiny canvas maintaining aspect ratio
        const aspectRatio = width / height;
        let thumbWidth, thumbHeight;

        if (aspectRatio > 1) {
            thumbWidth = size;
            thumbHeight = Math.round(size / aspectRatio);
        } else {
            thumbHeight = size;
            thumbWidth = Math.round(size * aspectRatio);
        }

        const canvas = document.createElement('canvas');
        canvas.width = thumbWidth;
        canvas.height = thumbHeight;

        const ctx = canvas.getContext('2d');

        // Apply slight blur for better compression
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(element, 0, 0, thumbWidth, thumbHeight);

        // Get PNG data URL
        const dataUrl = canvas.toDataURL('image/png', 0.5);

        // Strip data URL prefix and convert to raw bytes
        const base64Data = dataUrl.split(',')[1];
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        // Strip PNG headers and zlib wrapper
        const strippedData = this._stripPNGHeaders(bytes);

        // Prepend width and height to stripped data (1 byte each)
        const combined = new Uint8Array(2 + strippedData.length);
        combined[0] = thumbWidth & 0xff;   // Width (max 255)
        combined[1] = thumbHeight & 0xff;  // Height (max 255)
        combined.set(strippedData, 2);

        // // Convert to base64
        // const nanoData = btoa(String.fromCharCode(...combined));

        // console.log(`Generated nano thumbnail: ${thumbWidth}x${thumbHeight}, Size: ${nanoData.length} bytes`);

        return combined;
    }

    /**
     * Restores a full PNG from the stripped nano thumbnail data.
     * Reconstructs PNG headers and creates a valid PNG image.
     * @param {Uint8Array} nanoData - Stripped thumbnail data with embedded dimensions
     * @returns {string} Data URL of the restored PNG
     */
    static restore(nanoData) {
        // Decode base64 to bytes
        const bytes = Uint8Array.from(nanoData);

        // Extract width and height from first 2 bytes
        const width = bytes[0];
        const height = bytes[1];

        // Extract DEFLATE data (everything after first 2 bytes)
        const deflateData = bytes.slice(2);

        // Create a minimal PNG with proper headers
        const png = this._createMinimalPNG(width, height, deflateData);

        // Convert to data URL
        const base64 = btoa(String.fromCharCode(...png));
        return `data:image/png;base64,${base64}`;
    }

    /**
     * Strips PNG headers and zlib wrapper to minimize size.
     * @private
     * @param {Uint8Array} pngBytes - Full PNG data
     * @returns {Uint8Array} Raw DEFLATE compressed data only
     */
    static _stripPNGHeaders(pngBytes) {
        // Find IDAT chunk(s) - this contains the actual compressed image data
        const chunks = this._parsePNGChunks(pngBytes);
        const idatChunks = chunks.filter(chunk => chunk.type === 'IDAT');

        // Combine all IDAT data
        let idatData = new Uint8Array(0);
        for (const chunk of idatChunks) {
            const temp = new Uint8Array(idatData.length + chunk.data.length);
            temp.set(idatData);
            temp.set(chunk.data, idatData.length);
            idatData = temp;
        }

        // Strip zlib wrapper:
        // - First 2 bytes: zlib header (CMF + FLG)
        // - Last 4 bytes: Adler-32 checksum
        // Keep only the raw DEFLATE data in the middle
        if (idatData.length > 6) {
            return idatData.slice(2, idatData.length - 4);
        }

        // Fallback if data is too small
        return idatData;
    }

    /**
     * Parses PNG chunks from byte array.
     * @private
     * @param {Uint8Array} bytes - PNG file bytes
     * @returns {Array<{type: string, data: Uint8Array}>}
     */
    static _parsePNGChunks(bytes) {
        const chunks = [];
        let offset = 8; // Skip PNG signature

        while (offset < bytes.length) {
            // Read chunk length (4 bytes, big-endian)
            const length = (bytes[offset] << 24) | (bytes[offset + 1] << 16) |
                          (bytes[offset + 2] << 8) | bytes[offset + 3];
            offset += 4;

            // Read chunk type (4 bytes)
            const type = String.fromCharCode(bytes[offset], bytes[offset + 1],
                                            bytes[offset + 2], bytes[offset + 3]);
            offset += 4;

            // Read chunk data
            const data = bytes.slice(offset, offset + length);
            offset += length;

            // Skip CRC (4 bytes)
            offset += 4;

            chunks.push({ type, data });

            if (type === 'IEND') break;
        }

        return chunks;
    }

    /**
     * Creates a minimal valid PNG file from DEFLATE data.
     * Restores zlib wrapper around raw DEFLATE data.
     * @private
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {Uint8Array} deflateData - Raw DEFLATE compressed data (no zlib wrapper)
     * @returns {Uint8Array} Complete PNG file bytes
     */
    static _createMinimalPNG(width, height, deflateData) {
        // Reconstruct zlib-wrapped data from raw DEFLATE
        const zlibData = new Uint8Array(2 + deflateData.length + 4);

        // Zlib header (2 bytes)
        zlibData[0] = 0x78; // CMF: Compression method (8) + info (7)
        zlibData[1] = 0x9C; // FLG: Default compression level

        // Copy DEFLATE data
        zlibData.set(deflateData, 2);

        // Calculate Adler-32 checksum
        const adler = this._simpleAdler32(deflateData);
        zlibData[2 + deflateData.length] = (adler >> 24) & 0xff;
        zlibData[2 + deflateData.length + 1] = (adler >> 16) & 0xff;
        zlibData[2 + deflateData.length + 2] = (adler >> 8) & 0xff;
        zlibData[2 + deflateData.length + 3] = adler & 0xff;

        // PNG signature
        const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

        // IHDR chunk (image header)
        const ihdr = new Uint8Array(13);
        ihdr[0] = (width >> 24) & 0xff;
        ihdr[1] = (width >> 16) & 0xff;
        ihdr[2] = (width >> 8) & 0xff;
        ihdr[3] = width & 0xff;
        ihdr[4] = (height >> 24) & 0xff;
        ihdr[5] = (height >> 16) & 0xff;
        ihdr[6] = (height >> 8) & 0xff;
        ihdr[7] = height & 0xff;
        ihdr[8] = 8;  // Bit depth
        ihdr[9] = 6;  // Color type (RGBA)
        ihdr[10] = 0; // Compression method
        ihdr[11] = 0; // Filter method
        ihdr[12] = 0; // Interlace method

        const ihdrChunk = this._createPNGChunk('IHDR', ihdr);
        const idatChunk = this._createPNGChunk('IDAT', zlibData);
        const iendChunk = this._createPNGChunk('IEND', new Uint8Array(0));

        // Combine all parts
        const totalLength = signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
        const png = new Uint8Array(totalLength);
        let offset = 0;

        png.set(signature, offset);
        offset += signature.length;
        png.set(ihdrChunk, offset);
        offset += ihdrChunk.length;
        png.set(idatChunk, offset);
        offset += idatChunk.length;
        png.set(iendChunk, offset);

        return png;
    }

    /**
     * Creates a PNG chunk with proper format (length, type, data, CRC).
     * @private
     * @param {string} type - Chunk type (4 characters)
     * @param {Uint8Array} data - Chunk data
     * @returns {Uint8Array} Complete chunk bytes
     */
    static _createPNGChunk(type, data) {
        const length = data.length;
        const chunk = new Uint8Array(4 + 4 + length + 4); // length + type + data + CRC

        // Length (4 bytes, big-endian)
        chunk[0] = (length >> 24) & 0xff;
        chunk[1] = (length >> 16) & 0xff;
        chunk[2] = (length >> 8) & 0xff;
        chunk[3] = length & 0xff;

        // Type (4 bytes)
        for (let i = 0; i < 4; i++) {
            chunk[4 + i] = type.charCodeAt(i);
        }

        // Data
        chunk.set(data, 8);

        // CRC (4 bytes) - calculate CRC32 of type + data
        const crc = this._crc32(chunk.slice(4, 8 + length));
        chunk[8 + length] = (crc >> 24) & 0xff;
        chunk[8 + length + 1] = (crc >> 16) & 0xff;
        chunk[8 + length + 2] = (crc >> 8) & 0xff;
        chunk[8 + length + 3] = crc & 0xff;

        return chunk;
    }

    /**
     * Calculates CRC32 checksum for PNG chunks.
     * @private
     * @param {Uint8Array} data - Data to checksum
     * @returns {number} CRC32 value
     */
    static _crc32(data) {
        let crc = 0xffffffff;

        for (let i = 0; i < data.length; i++) {
            crc ^= data[i];
            for (let j = 0; j < 8; j++) {
                crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
            }
        }

        return (crc ^ 0xffffffff) >>> 0;
    }

    /**
     * Simple Adler-32 checksum calculation.
     * @private
     * @param {Uint8Array} data - Data to checksum
     * @returns {number} Adler-32 value
     */
    static _simpleAdler32(data) {
        const MOD_ADLER = 65521;
        let a = 1;
        let b = 0;

        for (let i = 0; i < Math.min(data.length, 256); i++) {
            a = (a + data[i]) % MOD_ADLER;
            b = (b + a) % MOD_ADLER;
        }

        return ((b << 16) | a) >>> 0;
    }
}
