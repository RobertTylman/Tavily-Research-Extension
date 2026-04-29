const sharp = require('sharp');
const fs = require('fs');

const svgBuffer = fs.readFileSync('public/icons/notebook.svg');

[16, 48, 128].forEach(size => {
  sharp(svgBuffer)
    .resize(size, size)
    .png()
    .toFile(`public/icons/icon${size}.png`)
    .then(() => console.log(`Created icon${size}.png`))
    .catch(err => console.error(err));
});
