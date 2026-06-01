const fs = require('fs');
const path = require('path');

const displayPath = path.join(__dirname, '../settings/display.json');

function getDisplayAll() {
    try {
        if (!fs.existsSync(displayPath)) return {};
        const data = fs.readFileSync(displayPath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading display.json:', error);
        return {};
    }
}

function getDisplay(code) {
    const data = getDisplayAll();
    return data[code] || { buttons: true, embeds: true, platform: 'ytsearch' };
}

function setDisplay(code, updates) {
    try {
        const data = getDisplayAll();
        data[code] = { ...getDisplay(code), ...updates };
        fs.writeFileSync(displayPath, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('Error writing display.json:', error);
        return false;
    }
}

module.exports = {
    getDisplay,
    setDisplay,
    getDisplayAll
};
