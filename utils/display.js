const store = require('./store');

function getDisplayAll() {
    return store.get('display') || {};
}

function getDisplay(code) {
    const data = getDisplayAll();
    return data[code] || { buttons: true, embeds: true, platform: 'ytsearch' };
}

function setDisplay(code, updates) {
    try {
        const data = getDisplayAll();
        data[code] = { ...getDisplay(code), ...updates };
        store.set('display', data);
        return true;
    } catch (error) {
        console.error('Error writing display:', error);
        return false;
    }
}

module.exports = {
    getDisplay,
    setDisplay,
    getDisplayAll
};
