const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BROWSER_CONFIG = {
    WEB: {
        port: 9222,
        exePath:
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        userDataDir:
            'C:\\ChromeData'
    },

    WEB2: {
        port: 9223,
        exePath:
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        userDataDir:
            'C:\\EdgeData'
    },

    WEB3: {
        port: 9224,
        exePath:
            'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        userDataDir:
            'C:\\BraveData'
    }
};

function getBrowserConfig(browserChoice) {

    const value =
        String(browserChoice || 'WEB')
            .trim()
            .toUpperCase();

    if (
        value === 'WEB2' ||
        value === 'WEB 2' ||
        value === 'EDGE'
    ) {
        return {
            type: 'WEB2',
            ...BROWSER_CONFIG.WEB2
        };
    }

    if (
        value === 'WEB3' ||
        value === 'WEB 3' ||
        value === 'BRAVE'
    ) {
        return {
            type: 'WEB3',
            ...BROWSER_CONFIG.WEB3
        };
    }

    return {
        type: 'WEB',
        ...BROWSER_CONFIG.WEB
    };
}


async function startManualLogin(
    browserChoice,
    credentials,
    options = {}
) {

    try {

        const config =
            getBrowserConfig(browserChoice);

        const targetUrl =
            'https://www.irctc.co.in/nget/train-search';

        console.log(
            `[LOGIN ${config.type}] Connecting...`
        );

        console.log(
            `[LOGIN ${config.type}] Port: ${config.port}`
        );

        console.log(
            `[LOGIN ${config.type}] Profile: ${config.userDataDir}`
        );

        console.log(
    `[LOGIN ${config.type}] Username received: ${
        credentials?.username ? 'YES' : 'NO'
    }`
);

console.log(
    `[LOGIN ${config.type}] Password received: ${
        credentials?.password ? 'YES' : 'NO'
    }`
);

        let browser = null;
        let retries = 6;


        while (retries > 0) {

            try {

                browser =
                    await puppeteer.connect({
                        browserURL:
                            `http://localhost:${config.port}`,
                        defaultViewport: null
                    });

                break;

            } catch (err) {

                retries--;

                if (retries === 5) {

                    console.log(
                        `[LAUNCH ${config.type}] Browser not running. Launching...`
                    );

                    const child =
                        spawn(
                            config.exePath,
                            [
                                `--remote-debugging-port=${config.port}`,
                                `--user-data-dir=${config.userDataDir}`,
                                targetUrl
                            ],
                            {
                                detached: true,
                                stdio: 'ignore'
                            }
                        );

                    child.unref();
                }

                if (retries === 0) {

                    throw new Error(
                        `Failed to connect to ${config.type} on port ${config.port}.`
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


        const pages =
            await browser.pages();


        let page =
            pages.find(
                p =>
                    !p.isClosed() &&
                    p.url().includes(
                        'irctc.co.in'
                    )
            );


        if (!page) {

            page =
                pages.find(
                    p => !p.isClosed()
                );
        }


        if (!page) {

            page =
                await browser.newPage();

            await page.goto(
                targetUrl,
                {
                    waitUntil: 'domcontentloaded'
                }
            );
        }


        console.log(
            `[LOGIN ${config.type}] Page: ${await page.url()}`
        );


        console.log(
            `[LOGIN ${config.type}] Please login manually...`
        );


        const timeout =
            Number(
                options.timeout ||
                10 * 60 * 1000
            );


        await page.waitForFunction(
            () => {

                const bodyText =
                    document.body
                        ? document.body.innerText
                            .toUpperCase()
                        : '';

                return (
                    bodyText.includes('LOGOUT') ||
                    bodyText.includes('MY ACCOUNT') ||
                    window.location.href.includes(
                        'user-profile'
                    )
                );

            },
            {
                timeout,
                polling: 1000
            }
        );


        console.log(
            `[LOGIN ${config.type}] Login detected successfully.`
        );


        const cookies =
            await page.cookies(
                'https://www.irctc.co.in'
            );


        const cookieString =
            cookies
                .map(
                    c =>
                        `${c.name}=${c.value}`
                )
                .join('; ');


        const sessionData = {

            browserType:
                config.type,

            cookies:
                cookieString,

            loginTime:
                new Date().toISOString()
        };


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
                `session_${config.type.toLowerCase()}.json`
            );


        fs.writeFileSync(
            sessionFilePath,
            JSON.stringify(
                sessionData,
                null,
                2
            ),
            'utf8'
        );


        console.log(
            `[LOGIN ${config.type}] Session saved: ${sessionFilePath}`
        );


        return {
            success: true,
            browser,
            page,
            session: sessionData
        };


    } catch (error) {

        console.error(
            '[LOGIN ERROR]',
            error.message
        );

        return {
            success: false,
            error:
                error.message
        };
    }
}


module.exports = {
    startManualLogin
};