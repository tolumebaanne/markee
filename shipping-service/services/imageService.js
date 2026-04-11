const sharp = require('sharp');

const STEPS = [
    [800, 80], [800, 60], [800, 40], [600, 40], [400, 35]
];

async function compress(buffer, targetKb = 50) {
    const targetBytes = targetKb * 1024;
    let output;
    for (const [width, quality] of STEPS) {
        output = await sharp(buffer)
            .resize(width, width, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality })
            .toBuffer();
        if (output.length <= targetBytes) break;
    }
    if (!output || output.length > targetBytes) {
        throw new Error('Image cannot be compressed to target size');
    }
    return output;
}

module.exports = { compress };
