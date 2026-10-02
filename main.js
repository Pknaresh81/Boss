const {
    app,
    BrowserWindow,
    ipcMain,
    session
} = require('electron');

const {
    verifyLicense
} = require('./licenseManager');

// ==========================================
// BOT PROTECTION / AKAMAI WAF BYPASS FIXES
// ==========================================
app.commandLine.appendSwitch('disable-http2');
app.commandLine.appendSwitch('disable-site-isolation-trials');
app.commandLine.appendSwitch('disable-features', 'VizDisplayCompositor,IsolateOrigins,site-per-process');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-setuid-sandbox');
app.commandLine.appendSwitch('disable-web-security');
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('disable-blink-features', 'AutofillServerCommunication');
app.commandLine.appendSwitch('disable-component-update');

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');
const puppeteer = require('puppeteer');

const APIEngine = require('./apiengine');
const { startManualLogin } = require('./loginManager');

let win = null;
let licenseWindow = null;
let miniAutomationWindows = new Map();

let licenseVerified = false;

ipcMain.handle(
    'open-mini-automation-window',
    async (event, ticketData, ticketIndex) => {

        try {

            const windowId =
                'mini-' +
                Date.now() +
                '-' +
                Math.random()
                    .toString(36)
                    .substring(2, 7);

            /*
             * Browser identity ticket ke saath preserve karo.
             * WEB / WEB2 / WEB3 hi use honge.
             */
            const browserType =
                String(
                    ticketData?.browserType ||
                    ticketData?.browserChoice ||
                    'WEB'
                )
                .trim()
                .toUpperCase();

            const miniWin =
                new BrowserWindow({

                    width: 340,
                    height: 230,

                    parent: null,
                    modal: false,

                    frame: false,
                    movable: true,
                    resizable: false,

                    alwaysOnTop: false,
                    show: true,

                    webPreferences: {
                        preload: path.join(
                            __dirname,
                            'preload.js'
                        ),
                        nodeIntegration: false,
                        contextIsolation: true
                    }

                });

            miniAutomationWindows.set(
                windowId,
                miniWin
            );

            await miniWin.loadFile(
                path.join(
                    __dirname,
                    'mini-window.html'
                )
            );

            /*
             * Browser type ko mini window ke andar
             * explicitly bhejo.
             */
            miniWin.webContents.send(
                'mini-window-data',
                {
                    windowId,
                    ticketData: {
                        ...ticketData,
                        browserType
                    },
                    ticketIndex,
                    browserType
                }
            );

            miniWin.on(
                'closed',
                () => {

                    miniAutomationWindows.delete(
                        windowId
                    );

                }
            );

            console.log(
                `[MINI ${browserType}] Window created: ${windowId}`
            );

            return {
                success: true,
                windowId,
                browserType
            };

        } catch (error) {

            console.error(
                '[MINI WINDOW] Error:',
                error
            );

            return {
                success: false,
                error:
                    error?.message ||
                    'Mini window failed.'
            };
        }
    }
);


ipcMain.on(
    'close-mini-automation-window',
    (event, windowId) => {

        const miniWin =
            miniAutomationWindows.get(
                windowId
            );

        if (
            miniWin &&
            !miniWin.isDestroyed()
        ) {

            miniWin.close();

        }

        miniAutomationWindows.delete(
            windowId
        );
    }
);

// ==========================================
// MULTI-BROWSER CONFIG
// ==========================================

const BOSS_BROWSER_ROOT = path.join(
    process.env.LOCALAPPDATA || os.homedir(),
    'Boss',
    'BrowserProfiles'
);

const BROWSER_CONFIG = {

    WEB: {
        type: 'WEB',
        name: 'Chrome',
        port: 9222,
        userDataDir: path.join(
            BOSS_BROWSER_ROOT,
            'Chrome'
        )
    },

    WEB2: {
        type: 'WEB2',
        name: 'Edge',
        port: 9223,
        userDataDir: path.join(
            BOSS_BROWSER_ROOT,
            'Edge'
        )
    },

    WEB3: {
        type: 'WEB3',
        name: 'Brave',
        port: 9224,
        userDataDir: path.join(
            BOSS_BROWSER_ROOT,
            'Brave'
        )
    }

};

// ==========================================
// BROWSER SETUP STATE
// ==========================================

const BROWSER_SETUP_VERSION = 1;

const BROWSER_SETUP_FILE = path.join(
    process.env.LOCALAPPDATA || os.homedir(),
    'Boss',
    'browser-setup.json'
);


// ==========================================
// CHECK BROWSER SETUP COMPLETE
// ==========================================

function isBrowserSetupComplete() {

    try {

        if (!fs.existsSync(BROWSER_SETUP_FILE)) {
            return false;
        }

        const data =
            JSON.parse(
                fs.readFileSync(
                    BROWSER_SETUP_FILE,
                    'utf8'
                )
            );

        return (
            data &&
            data.version === BROWSER_SETUP_VERSION &&
            data.completed === true
        );

    } catch (error) {

        console.error(
            '[BROWSER SETUP] Failed to read setup state:',
            error
        );

        return false;
    }
}


// ==========================================
// SAVE BROWSER SETUP COMPLETE
// ==========================================

function saveBrowserSetupComplete() {

    try {

        const dir =
            path.dirname(
                BROWSER_SETUP_FILE
            );

        if (!fs.existsSync(dir)) {

            fs.mkdirSync(
                dir,
                {
                    recursive: true
                }
            );
        }


        fs.writeFileSync(

            BROWSER_SETUP_FILE,

            JSON.stringify(
                {
                    version:
                        BROWSER_SETUP_VERSION,

                    completed:
                        true,

                    completedAt:
                        new Date().toISOString()
                },
                null,
                2
            ),

            'utf8'
        );


        console.log(
            '[BROWSER SETUP] Setup state saved.'
        );

    } catch (error) {

        console.error(
            '[BROWSER SETUP] Failed to save setup state:',
            error
        );
    }
}

// ==========================================
// FIND INSTALLED BROWSER
// ==========================================

function findExistingBrowserPath(paths) {

    for (const browserPath of paths) {

        if (
            browserPath &&
            fs.existsSync(browserPath)
        ) {
            return browserPath;
        }

    }

    return null;
}


function getInstalledBrowserPath(type) {

    const programFiles =
        process.env.ProgramFiles ||
        'C:\\Program Files';

    const programFilesX86 =
        process.env['ProgramFiles(x86)'] ||
        'C:\\Program Files (x86)';

    const localAppData =
        process.env.LOCALAPPDATA ||
        path.join(
            os.homedir(),
            'AppData',
            'Local'
        );


    if (type === 'WEB') {

        return findExistingBrowserPath([

            path.join(
                programFiles,
                'Google',
                'Chrome',
                'Application',
                'chrome.exe'
            ),

            path.join(
                programFilesX86,
                'Google',
                'Chrome',
                'Application',
                'chrome.exe'
            ),

            path.join(
                localAppData,
                'Google',
                'Chrome',
                'Application',
                'chrome.exe'
            )

        ]);

    }


    if (type === 'WEB2') {

        return findExistingBrowserPath([

            path.join(
                programFiles,
                'Microsoft',
                'Edge',
                'Application',
                'msedge.exe'
            ),

            path.join(
                programFilesX86,
                'Microsoft',
                'Edge',
                'Application',
                'msedge.exe'
            ),

            path.join(
                localAppData,
                'Microsoft',
                'Edge',
                'Application',
                'msedge.exe'
            )

        ]);

    }


    if (type === 'WEB3') {

        return findExistingBrowserPath([

            path.join(
                programFiles,
                'BraveSoftware',
                'Brave-Browser',
                'Application',
                'brave.exe'
            ),

            path.join(
                programFilesX86,
                'BraveSoftware',
                'Brave-Browser',
                'Application',
                'brave.exe'
            ),

            path.join(
                localAppData,
                'BraveSoftware',
                'Brave-Browser',
                'Application',
                'brave.exe'
            )

        ]);

    }

    return null;
}


// ==========================================
// GET BROWSER CONFIG
// ==========================================

function getBrowserConfig(browser) {

    const value =
        String(browser || 'WEB')
            .trim()
            .toUpperCase();

    let type = 'WEB';

    if (
        value === 'WEB2' ||
        value === 'WEB 2' ||
        value === 'EDGE'
    ) {

        type = 'WEB2';

    } else if (
        value === 'WEB3' ||
        value === 'WEB 3' ||
        value === 'BRAVE'
    ) {

        type = 'WEB3';

    }


    const baseConfig =
        BROWSER_CONFIG[type];

    const exePath =
        getInstalledBrowserPath(type);


    return {
        ...baseConfig,
        exePath,
        installed: Boolean(exePath)
    };

}

// ==========================================
// CHECK REMOTE DEBUGGING STATUS
// ==========================================

async function isBrowserDebugReady(config) {

    if (!config || !config.installed) {
        return false;
    }

    try {

        const browser =
            await puppeteer.connect({
                browserURL:
                    `http://127.0.0.1:${config.port}`,
                defaultViewport: null
            });

        await browser.disconnect();

        return true;

    } catch (error) {

        return false;

    }
}


// ==========================================
// WAIT FOR REMOTE DEBUGGING
// ==========================================

async function waitForBrowserDebug(
    config,
    timeoutMs = 15000,
    intervalMs = 250
) {

    const startedAt =
        Date.now();

    while (
        Date.now() - startedAt <
        timeoutMs
    ) {

        if (
            await isBrowserDebugReady(config)
        ) {
            return true;
        }

        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    intervalMs
                )
        );

    }

    return false;
}


// ==========================================
// LAUNCH BROWSER + WAIT FOR DEBUG PORT
// ==========================================

async function launchBrowser(
    config,
    targetUrl = 'https://www.irctc.co.in'
) {

    if (!config || !config.installed) {

        return {
            success: false,
            status: 'NOT_INSTALLED',
            error:
                `${config?.name || 'Browser'} installed nahi hai.`
        };

    }


    if (
        await isBrowserDebugReady(config)
    ) {

        return {
            success: true,
            status: 'READY',
            alreadyRunning: true,
            browserType: config.type
        };

    }


    try {

        fs.mkdirSync(
            config.userDataDir,
            {
                recursive: true
            }
        );


        console.log(
            `[LAUNCH ${config.type}] Starting ${config.name}...`
        );

        console.log(
            `[LAUNCH ${config.type}] EXE: ${config.exePath}`
        );

        console.log(
            `[LAUNCH ${config.type}] PORT: ${config.port}`
        );

        console.log(
            `[LAUNCH ${config.type}] PROFILE: ${config.userDataDir}`
        );


       const child = spawn(
    config.exePath,
    [
        `--remote-debugging-port=${config.port}`,
        `--user-data-dir=${config.userDataDir}`,
        '--disable-blink-features=AutomationControlled',
        '--window-size=500,680', // <-- Specific width aur height force karein
        '--window-position=400,30', // <-- Screen position set karein
        '--excludeSwitches=enable-automation', // <-- ISSE BANNER HATEGA
        '--no-default-browser-check',
        config.type === 'WEB2' ? '--inprivate' : '--incognito',
        targetUrl
    ],
    {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
    }
);


        child.unref();


        const ready =
            await waitForBrowserDebug(
                config,
                15000,
                250
            );


        if (!ready) {

            return {
                success: false,
                status: 'ERROR',
                error:
                    `${config.name} start hua, lekin remote debugging port ${config.port} ready nahi hua.`
            };

        }


        console.log(
            `[LAUNCH ${config.type}] Remote debugging READY.`
        );


        return {
            success: true,
            status: 'READY',
            alreadyRunning: false,
            browserType: config.type
        };


    } catch (error) {

        console.error(
            `[LAUNCH ${config.type}] Failed:`,
            error.message
        );


        return {
            success: false,
            status: 'ERROR',
            error:
                error?.message ||
                `${config.name} launch failed.`
        };

    }

}

// ==========================================
// GET ALL BROWSER STATUSES
// ==========================================

ipcMain.handle(
    'get-browser-statuses',
    async () => {

        const browserTypes = [
            'WEB',
            'WEB2',
            'WEB3'
        ];

        const results =
            await Promise.all(
                browserTypes.map(
                    async (type) => {

                        const config =
                            getBrowserConfig(type);

                        const connected =
                            config.installed &&
                            await isBrowserDebugReady(
                                config
                            );

                        return {

                            type:
                                config.type,

                            name:
                                config.name,

                            port:
                                config.port,

                            installed:
                                config.installed,

                            connected:
                                connected,

                            status:
                                !config.installed
                                    ? 'NOT_INSTALLED'
                                    : connected
                                        ? 'READY'
                                        : 'STOPPED',

                            error:
                                null

                        };

                    }
                )
            );


        return {
            success: true,
            statuses: results
        };

    }
);


// ==========================================
// PREPARE ALL INSTALLED BROWSERS
// ==========================================

ipcMain.handle(
    'prepare-browsers',
    async () => {

        const browserTypes = [
            'WEB',
            'WEB2',
            'WEB3'
        ];


        // ==========================================
        // SETUP ALREADY COMPLETED
        // ==========================================

        if (isBrowserSetupComplete()) {

            console.log(
                '[BROWSER SETUP] Setup already completed.'
            );

            console.log(
                '[BROWSER SETUP] Skipping automatic browser launch.'
            );


            const statuses =
                browserTypes.map(
                    (type) => {

                        const config =
                            getBrowserConfig(type);


                        return {

                            type:
                                config.type,

                            name:
                                config.name,

                            port:
                                config.port,

                            installed:
                                config.installed,

                            /*
                             * Browser ko yahan launch/check nahi karna.
                             * READY ka matlab:
                             * browser installed hai aur user
                             * icon par click karke connect kar sakta hai.
                             */
                            connected:
                                false,

                            status:
                                config.installed
                                    ? 'READY'
                                    : 'NOT_INSTALLED',

                            setupComplete:
                                true,

                            error:
                                null
                        };

                    }
                );


            return {

                success:
                    true,

                setupComplete:
                    true,

                setupSkipped:
                    true,

                statuses:
                    statuses
            };
        }


        // ==========================================
        // FIRST-TIME SETUP
        // ==========================================

        console.log(
            '[BROWSER SETUP] First-time setup started.'
        );


        const results =
            await Promise.all(
                browserTypes.map(
                    async (type) => {

                        const config =
                            getBrowserConfig(type);


                        console.log(
                            `[BROWSER STATUS] ${config.name}: ` +
                            `${config.installed ? 'Installed' : 'Not Installed'}`
                        );


                        // ------------------------------------------
                        // NOT INSTALLED
                        // ------------------------------------------

                        if (!config.installed) {

                            return {

                                type:
                                    config.type,

                                name:
                                    config.name,

                                port:
                                    config.port,

                                installed:
                                    false,

                                connected:
                                    false,

                                status:
                                    'NOT_INSTALLED',

                                error:
                                    `${config.name} installed nahi hai.`

                            };
                        }


                        // ------------------------------------------
                        // FIRST SETUP -> LAUNCH
                        // ------------------------------------------

                        const result =
                            await launchBrowser(
                                config
                            );


                        return {

                            type:
                                config.type,

                            name:
                                config.name,

                            port:
                                config.port,

                            installed:
                                true,

                            connected:
                                Boolean(
                                    result.success
                                ),

                            status:
                                result.status,

                            error:
                                result.error ||
                                null

                        };

                    }
                )
            );


        // ==========================================
        // SAVE SETUP ONLY WHEN ALL INSTALLED
        // BROWSERS ARE READY
        // ==========================================

        const installedResults =
            results.filter(
                browser =>
                    browser.installed
            );


        const setupSuccessful =
            installedResults.length > 0 &&
            installedResults.every(
                browser =>
                    browser.status === 'READY'
            );


        if (setupSuccessful) {

            saveBrowserSetupComplete();

            console.log(
                '[BROWSER SETUP] First-time setup completed.'
            );

        } else {

            console.log(
                '[BROWSER SETUP] Setup not marked complete.'
            );

        }


        return {

            success:
                true,

            setupComplete:
                setupSuccessful,

            setupSkipped:
                false,

            statuses:
                results
        };

    }
);

ipcMain.handle(
    'open-selected-browser',
    async (event, browserName) => {

        try {

            const config =
                getBrowserConfig(browserName);

            const targetUrl =
                'https://www.irctc.co.in';


            console.log(
                `[LAUNCH ${config.type}] ` +
                `${config.name} ` +
                `Port=${config.port} ` +
                `Profile=${config.userDataDir}`
            );


            const result =
                await launchBrowser(
                    config,
                    targetUrl
                );


            if (!result.success) {

                return {
                    success: false,
                    browserType: config.type,
                    status: result.status,
                    error: result.error
                };

            }


            return {
                success: true,
                browserType: config.type,
                status: result.status,
                alreadyRunning:
                    Boolean(result.alreadyRunning)
            };


        } catch (error) {

            console.error(
                '[LAUNCH] Browser launch failed:',
                error.message
            );


            return {
                success: false,
                error:
                    error?.message ||
                    'Browser launch failed.'
            };

        }

    }
);

// ==========================================
// START BOOKING HANDLER
// ==========================================

ipcMain.handle(
    'start-booking',
    async (
        event,
        bookingData,
        targetBrowser
    ) => {

        try {

            console.log(
                `[MAIN] Starting booking for browser: ${targetBrowser}`
            );

            const config =
                getBrowserConfig(targetBrowser);

            const port =
                config.port;

            const exePath =
                config.exePath;

            const userDataDir =
                config.userDataDir;

            const targetUrl =
                'https://www.irctc.co.in/nget/train-search';

            console.log(
                `[${config.type}] Port=${port} Profile=${userDataDir}`
            );

            let browser = null;

const launchResult =
    await launchBrowser(
        config,
        targetUrl
    );

if (!launchResult.success) {

    throw new Error(
        launchResult.error ||
        `${config.name} launch nahi ho saka.`
    );
}

console.log(
    `[${config.type}] Browser READY. ` +
    `Already running: ${Boolean(launchResult.alreadyRunning)}`
);

let retries = 6;

while (retries > 0) {

                try {

                    browser =
                        await puppeteer.connect({
                            browserURL:
                                `http://localhost:${port}`,
                            defaultViewport: null
                        });

                    break;

                } catch (err) {

                    retries--;

                    if (retries === 5) {

    console.log(
        `[${config.type}] Browser connection failed. Waiting for existing browser...`
    );

    const ready =
        await waitForBrowserDebug(
            config,
            10000,
            500
        );

    if (!ready) {

        throw new Error(
            `${config.name} remote debugging port ${port} available nahi hai. ` +
            `Please ${config.name} ko Open Browser button se start karein.`
        );
    }
}

                    if (retries === 0) {

                        throw new Error(
                            `Failed to connect to ${config.type} on port ${port}.`
                        );
                    }

                    await new Promise(
                        resolve =>
                            setTimeout(
                                resolve,
                                1500
                            )
                    );
                }
            }

let page = null;

try {

    console.log(
        `[${config.type}] Using existing browser page...`
    );

    const pages =
        await browser.pages();

    page =
        pages.find(
            p =>
                p.url().includes('irctc.co.in')
        ) ||
        pages[0];

    if (!page) {

        throw new Error(
            `${config.name} mein koi browser page available nahi hai.`
        );
    }

    if (
        !page.url() ||
        page.url() === 'about:blank'
    ) {

        await page.goto(
            targetUrl,
            {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            }
        );
    }

    console.log(
        `[${config.type}] Existing browser page selected.`
    );

} catch (pageError) {

    console.error(
        `[${config.type}] Existing browser page failed:`,
        pageError.message
    );

    throw new Error(
        `${config.name} browser page use nahi ho saka: ` +
        pageError.message
    );
}

            console.log(
                `[${config.type}] Connected to page: ${await page.url()}`
            );

            const apiEngine =
    new APIEngine(
        page,
        win,
        null,
        config.type
    );

// ==========================================
// NORMALIZE IRCTC CREDENTIALS
// ==========================================

if (
    !bookingData.credentials ||
    typeof bookingData.credentials !== 'object'
) {
    bookingData.credentials = {};
}

bookingData.credentials.username =
    String(
        bookingData.credentials.username || ''
    ).trim();

bookingData.credentials.password =
    String(
        bookingData.credentials.password || ''
    );

// ==========================================
// START API ENGINE BOOKING
// ==========================================

const result =
    await apiEngine.bookTicket(
        bookingData
    );


            return result;

        } catch (error) {

            console.error(
                '[MAIN] Error during booking flow:',
                error.message
            );

            return {
                success: false,
                error:
                    error.message
            };
        }
    }
);


// ==========================================
// CREATE INDEPENDENT LICENSE WINDOW
// ==========================================

function createLicenseWindow() {

    if (
        licenseWindow &&
        !licenseWindow.isDestroyed()
    ) {
        licenseWindow.focus();
        return;
    }

    licenseWindow = new BrowserWindow({

        width: 320,
        height: 180,

        minWidth: 320,
        minHeight: 180,

        maxWidth: 320,
        maxHeight: 180,

        frame: false,
        transparent: true,

        resizable: false,
        movable: true,

        minimizable: false,
        maximizable: false,
        fullscreenable: false,

        alwaysOnTop: true,

        show: false,

        webPreferences: {

            preload: path.join(
                __dirname,
                'preload.js'
            ),

            nodeIntegration: false,
            contextIsolation: true
        }
    });

    licenseWindow.loadFile(
        path.join(
            __dirname,
            'license.html'
        )
    );

    licenseWindow.once(
        'ready-to-show',
        () => {

            if (
                licenseWindow &&
                !licenseWindow.isDestroyed()
            ) {

                licenseWindow.show();
                licenseWindow.focus();
            }
        }
    );

    licenseWindow.on(
        'closed',
        () => {

            licenseWindow = null;

            /*
             * Agar user ne valid license enter kiye
             * bina window close kar di, application
             * close kar do.
             */

            if (!licenseVerified) {

                if (!app.isQuitting) {
                    app.quit();
                }
            }
        }
    );
}


ipcMain.on('close-license-window', () => {

    console.log('[LICENSE] Close button clicked');

    if (
        licenseWindow &&
        !licenseWindow.isDestroyed()
    ) {
        licenseWindow.close();
    }
});


ipcMain.handle('verify-license-key', async (event, licenseKey) => {
    console.log('[LICENSE] Verification request received:', licenseKey);

    try {
        const key = String(licenseKey || '').trim();

        if (!key) {
            console.log('[LICENSE] Empty key');

            return {
                success: false,
                message: 'License key enter karein.'
            };
        }

        console.log('[LICENSE] Calling verifyLicense()...');

        const result = await verifyLicense(key);

        console.log('[LICENSE] Firebase result:', result);

        if (!result || !result.success) {
            return {
                success: false,
                message: result?.message || 'Invalid license key.'
            };
        }

        licenseVerified = true;

        console.log('[LICENSE] Verification SUCCESS');

        if (licenseWindow && !licenseWindow.isDestroyed()) {
            licenseWindow.close();
        }

        if (!win || win.isDestroyed()) {
            console.log('[LICENSE] Creating dashboard...');
            createWindow();
        } else {
            win.show();
            win.focus();
        }

        return {
            success: true,
            message: result.message,
            expiryDate: result.expiryDate
        };

    } catch (error) {

        console.error(
            '[LICENSE] Verification ERROR:',
            error
        );

        return {
            success: false,
            message:
                error?.message ||
                'License verification failed.'
        };
    }
});

// ==========================================
// CREATE WINDOW
// ==========================================
function createWindow() {

    if (!licenseVerified) {
        return;
    }

    if (
        win &&
        !win.isDestroyed()
    ) {
        win.show();
        win.focus();
        return;
    }

    win = new BrowserWindow({
    width: 900,
    height: 800,

    frame: false,
    transparent: true,

    show: false,

    alwaysOnTop: false,
    hasShadow: true,

    backgroundColor: '#00000000',

    resizable: true,
    movable: false,
    maximizable: false,
    fullscreenable: false,

    webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true
    }
});


    // 1. New window/popup ya document khulne se rokne ke liye
win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('bobrupay.pdf') || url.includes('credit-card') || url.includes('co-brand') || url.includes('compare') || url.includes('ipay') || url.includes('drfat')) {
        console.log('[SECURITY] Blocked promotional document/popup:', url);
        return { action: 'deny' };
    }
    return { action: 'allow' };
});

// 2. Agar current window par hi yeh document load ho jaye toh wapas pichle page par jaane ke liye
win.webContents.on('did-navigate', async (event, url) => {
    if (url.includes('bobrupay.pdf') || url.includes('credit-card') || url.includes('co-brand') || url.includes('compare') || url.includes('ipay') || url.includes('drfat')) {
        console.log('[SECURITY] Blocked navigation to promotional doc. Going back...', url);
        if (win.webContents.canGoBack()) {
            win.webContents.goBack();
        }
    }
});


// ==========================================
    // FORCE CLOSE ALL WINDOWS & PROCESSES ON DASHBOARD CLOSE
    // ==========================================
    win.on('closed', () => {
        win = null;
        // Electron process level exit to immediately close mini-windows and child processes
        app.exit(0); 
    });


    // Load your app URL or file here (e.g., win.loadURL(...))


    // Real Chrome User-Agent set kar rahe hain
    const realUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    win.webContents.setUserAgent(realUserAgent);

    // ==========================================
    // ADVANCED AKAMAI / BOT FINGERPRINT BYPASS
    // ==========================================
    win.webContents.on('did-finish-load', () => {
        win.webContents.executeJavaScript(`
            // 1. Hide Webdriver flags completely
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });

            // 2. Mock Languages & Plugins to match real Windows Chrome
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en', 'hi']
            });

            Object.defineProperty(navigator, 'plugins', {
                get: () => [
                    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-plugin', description: 'Portable Document Format' },
                    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
                ]
            });

            // 3. Mock window.chrome runtime object to prevent bot detection
            window.chrome = {
                runtime: {
                    connect: function() {},
                    sendMessage: function() {}
                },
                loadTimes: function() {},
                csi: function() {},
                app: {}
            };

            // 4. Override permissions query
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: 'denied' }) :
                    originalQuery(parameters)
            );

            // 5. Spoof connection properties (Hardware concurrency & memory)
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
        `).catch(() => {});
    });

    // Intercept and inject essential headers to bypass WAF header filtering checks
    win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
        details.requestHeaders['User-Agent'] = realUserAgent;
        details.requestHeaders['Sec-Ch-Ua'] = '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"';
        details.requestHeaders['Sec-Ch-Ua-Mobile'] = '?0';
        details.requestHeaders['Sec-Ch-Ua-Platform'] = '"Windows"';
        callback({ requestHeaders: details.requestHeaders });
    });

    win.loadFile(
        path.join(
            __dirname,
            'index.html'
        )
    );

    win.once(
    'ready-to-show',
    () => {

        if (
            licenseVerified &&
            win &&
            !win.isDestroyed()
        ) {

            win.show();
            win.focus();
        }
    }
);
   
    win.on('closed', () => {
        win = null;
    });
}

// ==========================================
// SESSION EXTRACTION HELPER
// ==========================================

async function saveUserSession(
    targetWindow,
    browserType = 'WEB'
) {
    try {

        const type =
            String(browserType || 'WEB')
                .trim()
                .toUpperCase();

        const safeType =
            type === 'WEB2'
                ? 'web2'
                : type === 'WEB3'
                    ? 'web3'
                    : 'web';

        console.log(
            `[SESSION ${type}] Extracting session...`
        );

        const cookies =
            await targetWindow
                .webContents
                .session
                .cookies
                .get({
                    url:
                        'https://www.irctc.co.in'
                });

        const cookieString =
            cookies && cookies.length
                ? cookies
                    .map(
                        c =>
                            `${c.name}=${c.value}`
                    )
                    .join('; ')
                : '';

        const storageData =
            await targetWindow
                .webContents
                .executeJavaScript(`
                    (() => {

                        const localStorageData = {};
                        const sessionStorageData = {};

                        try {

                            for (
                                let i = 0;
                                i < localStorage.length;
                                i++
                            ) {
                                const key =
                                    localStorage.key(i);

                                localStorageData[key] =
                                    localStorage.getItem(key);
                            }

                            for (
                                let i = 0;
                                i < sessionStorage.length;
                                i++
                            ) {
                                const key =
                                    sessionStorage.key(i);

                                sessionStorageData[key] =
                                    sessionStorage.getItem(key);
                            }

                        } catch (e) {}

                        return {
                            localStorage:
                                localStorageData,

                            sessionStorage:
                                sessionStorageData
                        };

                    })();
                `)
                .catch(() => ({
                    localStorage: {},
                    sessionStorage: {}
                }));

        const sessionDir =
            path.join(
                __dirname,
                'Boss'
            );

        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(
                sessionDir,
                {
                    recursive: true
                }
            );
        }

        const sessionFilePath =
            path.join(
                sessionDir,
                `session_${safeType}.json`
            );

        const fullSessionPayload = {
            browserType: type,
            cookies: cookieString,
            localStorage:
                storageData.localStorage || {},
            sessionStorage:
                storageData.sessionStorage || {}
        };

        fs.writeFileSync(
            sessionFilePath,
            JSON.stringify(
                fullSessionPayload,
                null,
                2
            ),
            'utf8'
        );

        console.log(
            `[SESSION ${type}] Saved: ${sessionFilePath}`
        );

        return sessionFilePath;

    } catch (sessionErr) {

        console.error(
            `[SESSION ${browserType}] Save failed:`,
            sessionErr.message
        );

        return null;
    }
}

// ==========================================
// APP READY
// ==========================================

app.whenReady().then(() => {

    session.defaultSession.webRequest.onBeforeRequest(
        {
            urls: [
                '*://*.irctc.co.in/ngsw-worker.js'
            ]
        },
        (details, callback) => {
            callback({ cancel: true });
        }
    );

    /*
     * IMPORTANT:
     * App start par dashboard nahi,
     * sirf independent license window open hogi.
     */
    createLicenseWindow();

    app.on('activate', () => {

        /*
         * License verify nahi hua hai to
         * dashboard create/open nahi karna.
         */
        if (!licenseVerified) {

            if (
                !licenseWindow ||
                licenseWindow.isDestroyed()
            ) {
                createLicenseWindow();
            }

            return;
        }

        if (
            BrowserWindow.getAllWindows().length === 0
        ) {
            createWindow();
        }

    });
});

// ==========================================
// CLOSE ALL WINDOWS
// ==========================================

app.on('window-all-closed', () => {

    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// ==========================================
// RESIZE WINDOW
// ==========================================

ipcMain.on(
    'resize-window',
    (event, size = {}) => {

        if (
            !win ||
            win.isDestroyed()
        ) {
            return;
        }

        const width =
            Number(size.width);

        const height =
            Number(size.height);

        if (
            Number.isFinite(width) &&
            Number.isFinite(height) &&
            width > 0 &&
            height > 0
        ) {

            win.setSize(
                Math.round(width),
                Math.round(height)
            );
        }
    }
);

// ==========================================
// CAPTCHA STATE - PER BROWSER
// ==========================================

const captchaStates = {
    WEB: {
        active: false,
        resolve: null,
        reject: null,
        timeout: null
    },
    WEB2: {
        active: false,
        resolve: null,
        reject: null,
        timeout: null
    },
    WEB3: {
        active: false,
        resolve: null,
        reject: null,
        timeout: null
    }
};

function getCaptchaState(browserType) {
    const type = String(browserType || 'WEB')
        .trim()
        .toUpperCase();

    return captchaStates[type] || captchaStates.WEB;
}

// ==========================================
// CAPTCHA REQUEST
// ==========================================

function requestCaptchaFromUser(
    captchaImageSrc,
    browserType = 'WEB'
) {
    const state = getCaptchaState(browserType);

    return new Promise((resolve, reject) => {

        if (!win || win.isDestroyed()) {
            reject(
                new Error(
                    'Electron window available nahi hai.'
                )
            );
            return;
        }

        if (state.active) {
            reject(
                new Error(
                    `[${browserType}] Another CAPTCHA request is already active.`
                )
            );
            return;
        }

        state.active = true;
        state.resolve = resolve;
        state.reject = reject;

        state.timeout = setTimeout(() => {

            finishCaptchaRequest(
                new Error('CAPTCHA input timeout.'),
                null,
                browserType
            );

        }, 5 * 60 * 1000);

        win.webContents.send(
            'show-captcha-modal',
            {
                browserType: String(browserType || 'WEB').toUpperCase(),
                image: captchaImageSrc || null
            }
        );
    });
}

// ==========================================
// FINISH CAPTCHA REQUEST
// ==========================================

function finishCaptchaRequest(
    error = null,
    value = null,
    browserType = 'WEB'
) {
    const state = getCaptchaState(browserType);

    if (!state.active) {
        return;
    }

    if (state.timeout) {
        clearTimeout(state.timeout);
        state.timeout = null;
    }

    const resolve = state.resolve;
    const reject = state.reject;

    state.active = false;
    state.resolve = null;
    state.reject = null;

    if (error) {
        if (reject) {
            reject(error);
        }
        return;
    }

    if (resolve) {
        resolve(value);
    }
}

// ==========================================
// CAPTCHA SUBMIT
// ==========================================

ipcMain.on(
    'submit-captcha-response',
    (event, data) => {

        let browserType = 'WEB';
        let captchaText = '';

        if (
            data &&
            typeof data === 'object'
        ) {
            browserType =
                data.browserType || 'WEB';

            captchaText =
                data.captcha ||
                data.text ||
                '';
        } else {
            captchaText = data || '';
        }

        const state =
            getCaptchaState(browserType);

        if (!state.active) {

            console.warn(
                `[CAPTCHA ${browserType}] No active CAPTCHA request.`
            );

            return;
        }

        const value =
            String(captchaText || '').trim();

        if (!value) {

            console.warn(
                `[CAPTCHA ${browserType}] Empty CAPTCHA received.`
            );

            return;
        }

        console.log(
            `[CAPTCHA ${browserType}] User CAPTCHA received.`
        );

        finishCaptchaRequest(
            null,
            value,
            browserType
        );
    }
);

// ==========================================
// CAPTCHA CANCEL
// ==========================================

ipcMain.on(
    'cancel-captcha-response',
    (event, data) => {

        const browserType =
            data &&
            typeof data === 'object'
                ? data.browserType || 'WEB'
                : 'WEB';

        const state =
            getCaptchaState(browserType);

        if (!state.active) {
            return;
        }

        console.log(
            `[CAPTCHA ${browserType}] User cancelled CAPTCHA.`
        );

        finishCaptchaRequest(
            new Error(
                'CAPTCHA cancelled by user.'
            ),
            null,
            browserType
        );
    }
);

// ==========================================
// CAPTCHA IPC HANDLER
// ==========================================

ipcMain.handle(
    'solve-captcha-interactively',
    async (
        event,
        captchaImageSrc,
        browserType = 'WEB'
    ) => {

        try {

            const captcha =
                await requestCaptchaFromUser(
                    captchaImageSrc,
                    browserType
                );

            return {
                success: true,
                captcha
            };

        } catch (error) {

            return {
                success: false,
                error:
                    error?.message ||
                    'CAPTCHA failed.'
            };
        }
    }
);

// ==========================================
// START LOGIN
// ==========================================

ipcMain.handle(
    'start-login',
    async (
        event,
        payload = {}
    ) => {

        const browserChoice =
            String(
                payload.browserChoice || 'web'
            ).toLowerCase();

        const credentials =
            payload.credentials || null;

        console.log(
            '[LOGIN] Browser:',
            browserChoice
        );

        try {

            const result =
                await startManualLogin(
                    browserChoice,
                    credentials,
                    {
                        timeout:
                            10 * 60 * 1000
                    }
                );

            if (!result?.success) {

                return {
                    success: false,

                    error:
                        result?.error ||
                        'Login failed.'
                };
            }

            console.log(
                '[LOGIN] Login successful.'
            );

            return {
                success: true,

                message:
                    'IRCTC login successful.',

                session:
                    result.session || null
            };

        } catch (error) {

            console.error(
                '[LOGIN] Error:',
                error
            );

            return {
                success: false,

                error:
                    error?.message ||
                    'Login failed.'
            };
        }
    }
);

// ==========================================
// START TATKAL BOOKING
// ==========================================

ipcMain.handle(
    'start-tatkal-booking',
    async (
        event,
        payload = {}
    ) => {

        try {

            console.log(
                '[BOOKING] start-tatkal-booking received.'
            );

            console.log(
                '[DEBUG PAYLOAD]',
                JSON.stringify(payload)
            );

            const targetBrowser =
                payload.browserType ||
                payload.browserChoice ||
                payload.ticketData?.browserChoice ||
                'WEB';

            const config =
                getBrowserConfig(targetBrowser);

            const port =
                config.port;

            const exePath =
                config.exePath;

            const userDataDir =
                config.userDataDir;

            const targetUrl =
                'https://www.irctc.co.in/nget/train-search';

            console.log(
                `[${config.type}] Port=${port} Profile=${userDataDir}`
            );

            let browser = null;
            let retries = 6;

            while (retries > 0) {

                try {

                    browser =
                        await puppeteer.connect({
                            browserURL:
                                `http://localhost:${port}`,
                            defaultViewport: null
                        });

                    break;

                } catch (err) {

                    retries--;

                    if (retries === 5) {

    console.log(
        `[${config.type}] Browser connection failed. Waiting for existing browser...`
    );

    const ready =
        await waitForBrowserDebug(
            config,
            10000,
            500
        );

    if (!ready) {

        throw new Error(
            `${config.name} remote debugging port ${port} available nahi hai. ` +
            `Please ${config.name} ko Open Browser button se start karein.`
        );
    }
}

                    if (retries === 0) {

                        throw new Error(
                            `Failed to connect to ${config.type} on port ${port}.`
                        );
                    }

                    await new Promise(
                        resolve =>
                            setTimeout(
                                resolve,
                                1500
                            )
                    );
                }
            }

            let page = null;

try {

    console.log(
        `[${config.type}] Creating isolated browser context for Tatkal...`
    );

    const context =
        await browser.createBrowserContext();

    page =
        await context.newPage();

    console.log(
        `[${config.type}] Tatkal isolated context page created.`
    );

    await page.goto(
        targetUrl,
        {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        }
    );

} catch (contextError) {

    console.error(
        `[${config.type}] Tatkal isolated context failed:`,
        contextError.message
    );

    throw new Error(
        `${config.name} Tatkal isolated browser context create nahi ho saka: ` +
        contextError.message
    );
}


            console.log(
                `[${config.type}] Connected to page: ${await page.url()}`
            );

            const ticketData =
                payload.ticketData ||
                payload ||
                {};

            const apiEngine =
                new APIEngine(
                    page,
                    win,
                    null,
                    config.type
                );

            console.log(
                `[${config.type}] Tatkal booking starting for Train:`,
                ticketData.train ||
                ticketData.trainNo ||
                'N/A'
            );

console.log(
    `[${config.type}] Tatkal credentials received:`,
    ticketData?.credentials?.username ? 'YES' : 'NO'
);

console.log(
    `[${config.type}] Tatkal password received:`,
    ticketData?.credentials?.password ? 'YES' : 'NO'
);

            const response =
                await apiEngine.bookTicket(
                    ticketData,
                    payload.webOption || null
                );

            console.log(
                `[${config.type}] Tatkal booking process completed.`
            );

            return {
                success: true,
                data: response
            };

        } catch (error) {

            console.error(
                '[API ENGINE] Tatkal booking failed:',
                error
            );

            return {
                success: false,
                error:
                    error?.message ||
                    'Booking failed.'
            };
        }
    }
);

// ==========================================
// OPEN SPECIFIC BROWSER IPC HANDLER (UPDATED WITH DEBUG PORTS)
// ==========================================

ipcMain.handle(
    'open-browser-ticket',
    async (event, { browserType, ticketData }) => {

        try {

            const config =
                getBrowserConfig(browserType);

            const targetUrl =
                'https://www.irctc.co.in/nget/train-search';

            console.log(
                `[OPEN ${config.type}] ` +
                `${config.name} | ` +
                `Port=${config.port} | ` +
                `Profile=${config.userDataDir}`
            );

            const result =
                await launchBrowser(
                    config,
                    targetUrl
                );

            if (!result.success) {

                return {
                    success: false,
                    browserType: config.type,
                    status: result.status,
                    error: result.error
                };
            }

            return {
                success: true,
                browserType: config.type,
                status: result.status,
                alreadyRunning:
                    Boolean(result.alreadyRunning)
            };

        } catch (error) {

            console.error(
                '[OPEN BROWSER TICKET] Error:',
                error
            );

            return {
                success: false,
                error:
                    error?.message ||
                    'Browser open failed.'
            };
        }
    }
);

// ==========================================
// CLEANUP BEFORE APP QUIT
// ==========================================

app.on('before-quit', () => {

    for (
        const browserType of
        ['WEB', 'WEB2', 'WEB3']
    ) {

        const state =
            getCaptchaState(browserType);

        if (state.active) {

            finishCaptchaRequest(
                new Error(
                    'Application closed.'
                ),
                null,
                browserType
            );
        }
    }
});