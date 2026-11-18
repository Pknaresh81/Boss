
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

function getStorePath() {
    return path.join(app.getPath('userData'), 'api-keys.json');
}

function checkEncryption() {
    if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(
            'Windows secure storage available nahi hai. API keys save nahi hui.'
        );
    }
}

function readRawStore() {
    const file = getStorePath();

    if (!fs.existsSync(file)) {
        return {
            version: 1,
            directApiSh: '',
            railCore: ''
        };
    }

    const data = JSON.parse(
        fs.readFileSync(file, 'utf8')
    );

    if (data.version !== 1) {
        throw new Error('API key storage version invalid hai.');
    }

    return data;
}

function getApiKeyStatus() {
    const data = readRawStore();

    return {
        success: true,
        directApiShConfigured: Boolean(data.directApiSh),
        railCoreConfigured: Boolean(data.railCore)
    };
}

function saveApiKeys(values = {}) {
    checkEncryption();

    const current = readRawStore();

    const directApiSh = String(
        values.directApiSh || ''
    ).trim();

    const railCore = String(
        values.railCore || ''
    ).trim();

    if (!directApiSh && !railCore) {
        return {
            success: false,
            message: 'Kam se kam ek API key enter karein.'
        };
    }

    const next = {
        version: 1,

        directApiSh: directApiSh
            ? safeStorage.encryptString(directApiSh).toString('base64')
            : current.directApiSh,

        railCore: railCore
            ? safeStorage.encryptString(railCore).toString('base64')
            : current.railCore,

        updatedAt: new Date().toISOString()
    };

    const file = getStorePath();
    const directory = path.dirname(file);
    const tempFile = file + '.tmp';

    fs.mkdirSync(directory, { recursive: true });

    fs.writeFileSync(
        tempFile,
        JSON.stringify(next, null, 2),
        'utf8'
    );

    fs.renameSync(tempFile, file);

    return getApiKeyStatus();
}

// Secrets sirf Main Process ke liye.
// Renderer ko ye function expose nahi karna.
function getApiKeys() {
    checkEncryption();

    const data = readRawStore();

    return {
        directApiSh: data.directApiSh
            ? safeStorage.decryptString(
                Buffer.from(data.directApiSh, 'base64')
            )
            : '',

        railCore: data.railCore
            ? safeStorage.decryptString(
                Buffer.from(data.railCore, 'base64')
            )
            : ''
    };
}

module.exports = {
    getApiKeyStatus,
    saveApiKeys,
    getApiKeys
};
