const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

let activeLicenseScope = null;

function setLicenseScope(scope) {
    if (!/^[a-f0-9]{64}$/i.test(String(scope || ''))) {
        throw new Error('Invalid license scope for API key storage.');
    }

    activeLicenseScope = scope;

    const legacyFile = path.join(app.getPath('userData'), 'api-keys.json');
    const scopedFile = getStorePath();

    // First activated license receives the pre-existing shared encrypted keys once.
    if (!fs.existsSync(scopedFile) && fs.existsSync(legacyFile)) {
        fs.mkdirSync(path.dirname(scopedFile), { recursive: true });
        fs.copyFileSync(legacyFile, scopedFile);
        fs.unlinkSync(legacyFile);
        console.log('[API KEYS] Existing encrypted keys migrated to first activated license.');
    }
}

function getStorePath() {
    if (!activeLicenseScope) {
        throw new Error('License scope not set for API key storage.');
    }
    return path.join(
        app.getPath('userData'),
        'LicenseData',
        activeLicenseScope,
        'api-keys.json'
    );
}

function checkEncryption() {
    if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Windows secure storage available nahi hai. API keys save nahi hui.');
    }
}

function readRawStore() {
    const file = getStorePath();
    if (!fs.existsSync(file)) {
        return { version: 1, directApiSh: '', irctcDev: '' };
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== 1) throw new Error('API key storage version invalid hai.');
    return data;
}

function getApiKeyStatus() {
    const data = readRawStore();
    return {
        success: true,
        directApiShConfigured: Boolean(data.directApiSh),
        irctcDevConfigured: Boolean(data.irctcDev)
    };
}

function saveApiKeys(values = {}) {
    checkEncryption();
    const current = readRawStore();
    const directApiSh = String(values.directApiSh || '').trim();
    const irctcDev = String(values.irctcDev || '').trim();

    if (!directApiSh && !irctcDev) {
        return { success: false, message: 'Kam se kam ek API key enter karein.' };
    }

    const next = {
        version: 1,
        directApiSh: directApiSh
            ? safeStorage.encryptString(directApiSh).toString('base64')
            : current.directApiSh,
        irctcDev: irctcDev
            ? safeStorage.encryptString(irctcDev).toString('base64')
            : current.irctcDev,
        updatedAt: new Date().toISOString()
    };

    const file = getStorePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tempFile = file + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tempFile, file);
    return getApiKeyStatus();
}

function getApiKeys() {
    checkEncryption();
    const data = readRawStore();
    return {
        directApiSh: data.directApiSh
            ? safeStorage.decryptString(Buffer.from(data.directApiSh, 'base64'))
            : '',
        irctcDev: data.irctcDev
            ? safeStorage.decryptString(Buffer.from(data.irctcDev, 'base64'))
            : ''
    };
}

module.exports = { setLicenseScope, getApiKeyStatus, saveApiKeys, getApiKeys };
