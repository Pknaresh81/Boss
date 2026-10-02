const axios = require('axios');
const fs = require('fs');
const path = require('path');

class APIEngine {

    constructor(pageOrCaptcha = null, winOrCell = null, requestCaptcha = null, browserType = 'WEB') {

    if (typeof pageOrCaptcha === 'function') {
        this.requestCaptcha = pageOrCaptcha;
        this.win = winOrCell;
        this.page = null;
    } else {
        this.page = pageOrCaptcha;
        this.win = winOrCell;
        this.requestCaptcha =
            typeof requestCaptcha === 'function'
                ? requestCaptcha
                : null;
    }

    this.browserType = String(browserType || 'WEB')
        .trim()
        .toUpperCase();

    // Har browser ki separate session file
    this.sessionFilePath = path.join(
        __dirname,
        `session_${this.browserType.toLowerCase()}.json`
    );

    console.log(
        `[APIEngine] Browser=${this.browserType} | Session=${this.sessionFilePath}`
    );
}

    // ==========================================
    // HELPER: SEND LIVE PROGRESS TO UI
    // ==========================================
    sendProgress(stepName, message, percentage = 0) {
        console.log(`[PROGRESS] ${stepName}: ${message} (${percentage}%)`);
        if (this.win && this.win.webContents) {
            try {
                this.win.webContents.send('booking-progress', {
                    step: stepName,
                    message: message,
                    progress: percentage,
                    timestamp: new Date().toLocaleTimeString()
                });
            } catch (err) {
                console.warn('UI progress send error:', err.message);
            }
        }
    }

    // ==========================================
// HELPER: CONTROLLED DELAY (MS)
// ==========================================
delay(ms) {
    const delayMs = Number(ms);

    if (!Number.isFinite(delayMs) || delayMs < 0) {
        return Promise.resolve();
    }

    return new Promise(resolve => {
        setTimeout(resolve, delayMs);
    });
}

// ==========================================
// HELPER: RETRY BACKOFF
// ==========================================
getRetryDelay(attempt, baseDelay = 1000, maxDelay = 5000) {
    const safeAttempt = Math.max(1, Number(attempt) || 1);

    const delayMs = Math.min(
        maxDelay,
        baseDelay * Math.pow(2, safeAttempt - 1)
    );

    return delayMs;
}

    // ==========================================
    // SAFE FETCH (ENHANCED WITH ANTI-AKAMAI HEADERS)
    // ==========================================
    async safeFetch(url, options = {}) {

    const method =
        options.method || 'GET';

    const bodyData =
        options.body || null;

    const timeoutMs =
        Number(options.timeout || 15000);

    const customHeaders =
        options.headers || {};

    if (!this.page || this.page.isClosed()) {
        throw new Error(
            `[${this.browserType}] External browser page available nahi hai.`
        );
    }

    const bodyStr =
        bodyData
            ? (
                typeof bodyData === 'string'
                    ? bodyData
                    : JSON.stringify(bodyData)
            )
            : null;

    const finalHeaders = {
    ...customHeaders
};

    console.log(
        `[BROWSER ${this.browserType}] SAFE FETCH: ${url}`
    );

    const script = async function(args) {

        try {

            const response =
                await fetch(
                    args.url,
                    {
                        method: args.method,
                        headers: args.headers,
                        credentials: 'include',
                        body: args.body || undefined
                    }
                );

            const text =
                await response.text();

            return {
                status:
                    response.status,

                statusText:
                    response.statusText,

                body:
                    text
            };

        } catch (err) {

            return {
                status: 0,
                statusText: 'NET_ERROR',
                error: err.message,
                body: ''
            };
        }
    };

    try {

        const result =
    await Promise.race([

        this.page.evaluate(
            script,
            {
                url,
                method,
                headers: finalHeaders,
                body: bodyStr
            }
        ),

        new Promise(function(_, reject) {
            setTimeout(
                () => reject(new Error('TIMEOUT')),
                timeoutMs
            );
        })

    ]).catch(function(err) {

        const isTimeout =
            err &&
            err.message === 'TIMEOUT';

        return {
            status: 0,
            statusText:
                isTimeout
                    ? 'TIMEOUT'
                    : 'EXEC_ERROR',
            error:
                err?.message || 'Unknown browser execution error',
            body: ''
        };

    });

        return {

            status:
                result.status || 0,

            statusText:
                result.statusText || '',

            headers: {
                get: function() {
                    return null;
                },
                forEach: function() {},
                getSetCookie: function() {
                    return [];
                }
            },

            text: async function() {
                return result.body || '';
            }
        };

    } catch (error) {

        console.error(
            `[BROWSER ${this.browserType}] SAFE FETCH ERROR:`,
            error.message
        );

        return {

            status: 0,

            statusText:
                'NET_ERROR',

            headers: {
                get: function() {
                    return null;
                },
                forEach: function() {},
                getSetCookie: function() {
                    return [];
                }
            },

            text: async function() {
                return '';
            }
        };
    }
}

    // ==========================================
    // TRANSACTION ID GENERATOR
    // ==========================================
    generateTransactionId() {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let result = 'mt';
        for (let i = 0; i < 6; i++) {
            result += chars.charAt(
                Math.floor(
                    Math.random() * chars.length
                )
            );
        }
        return result;
    }

    // ==========================================
    // SESSION SAVE
    // ==========================================
    saveSession(data) {
        if (!data || typeof data !== 'object') {
            throw new Error('Session data invalid hai.');
        }

        try {
            fs.writeFileSync(
                this.sessionFilePath,
                JSON.stringify(data, null, 2),
                'utf8'
            );
            console.log('[SESSION] Session save ho gaya.');
        } catch (error) {
            console.error('[SESSION] Save failed:', error.message);
            throw new Error(`Session save failed: ${error.message}`);
        }
    }

// ==========================================
// IRCTC AUTO LOGIN
// RESPONSIVE LOGIN - SMALL / LARGE SCREEN
// ==========================================
async autoLogin(username, password) {

    if (!this.page || this.page.isClosed()) {
        throw new Error(
            `[${this.browserType}] Browser page available nahi hai.`
        );
    }

    console.log(
        `[AUTO LOGIN ${this.browserType}] Opening IRCTC page...`
    );

    await this.page.goto(
        'https://www.irctc.co.in/nget/train-search',
        {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        }
    );

    console.log(
        `[AUTO LOGIN ${this.browserType}] IRCTC page loaded.`
    );

    // ==========================================
// CLOSE IRCTC WELCOME / LANGUAGE POPUP
// SELECT ENGLISH ONLY
// ==========================================
console.log(
    `[AUTO LOGIN ${this.browserType}] Checking IRCTC welcome popup...`
);

try {

    const englishButton = await this.page.waitForFunction(
        () => {

            const buttons =
                Array.from(
                    document.querySelectorAll(
                        'button[type="submit"].btn.btn-primary'
                    )
                );

            return buttons.find(button =>
                button.textContent.trim() === 'English'
            ) || false;

        },
        {
            timeout: 5000
        }
    );

    if (englishButton) {

        console.log(
            `[AUTO LOGIN ${this.browserType}] English button found.`
        );

        await this.page.evaluate(() => {

            const button =
                Array.from(
                    document.querySelectorAll(
                        'button[type="submit"].btn.btn-primary'
                    )
                ).find(button =>
                    button.textContent.trim() === 'English'
                );

            if (!button) {
                throw new Error(
                    'English button not found.'
                );
            }

            button.click();
        });

        console.log(
            `[AUTO LOGIN ${this.browserType}] English selected.`
        );

        await new Promise(resolve =>
            setTimeout(resolve, 1000)
        );

    } else {

        console.log(
            `[AUTO LOGIN ${this.browserType}] English welcome button not present.`
        );
    }

} catch (popupError) {

    console.log(
        `[AUTO LOGIN ${this.browserType}] Welcome popup not detected or already closed.`
    );
}

    // ------------------------------------------
    // WAIT FOR PAGE TO SETTLE
    // ------------------------------------------
    await new Promise(resolve =>
        setTimeout(resolve, 1500)
    );

    // ==========================================
    // STEP 1
    // CHECK LOGIN FORM ALREADY OPEN
    // ==========================================
    const loginFormAlreadyOpen =
        await this.page.$(
            'input[formcontrolname="userid"]'
        );

    if (!loginFormAlreadyOpen) {

        console.log(
            `[AUTO LOGIN ${this.browserType}] Login form not open. Detecting screen layout...`
        );

        // ======================================
        // SMALL SCREEN
        // HAMBURGER MENU
        // ======================================
        const menuButton =
    await this.page.$(
        'i.fa.fa-align-justify'
    );

if (menuButton) {

    console.log(
        `[AUTO LOGIN ${this.browserType}] Small screen detected. Opening menu...`
    );

    try {

        await this.page.evaluate(() => {

            const icon =
                document.querySelector(
                    'i.fa.fa-align-justify'
                );

            if (!icon) {
                throw new Error(
                    'Hamburger icon not found.'
                );
            }

            const clickable =
                icon.closest(
                    'button, a, div'
                ) || icon;

            clickable.dispatchEvent(
                new MouseEvent(
                    'click',
                    {
                        bubbles: true,
                        cancelable: true,
                        view: window
                    }
                )
            );
        });

        console.log(
            `[AUTO LOGIN ${this.browserType}] Menu click triggered.`
        );

    } catch (menuError) {

        console.error(
            `[AUTO LOGIN ${this.browserType}] Menu click failed:`,
            menuError.message
        );

        throw new Error(
            `[${this.browserType}] IRCTC menu open nahi ho saka.`
        );
    }

    await new Promise(resolve =>
        setTimeout(resolve, 1000)
    );

} else {

    console.log(
        `[AUTO LOGIN ${this.browserType}] Hamburger menu not found.`
    );
}

        // ======================================
        // LARGE SCREEN
        // LOGIN / REGISTER BUTTON
        // ======================================
        const loginRegisterButton =
            await this.page.$(
                'button.search_btn'
            );

        if (loginRegisterButton) {

            console.log(
                `[AUTO LOGIN ${this.browserType}] LOGIN / REGISTER button found.`
            );

            await loginRegisterButton.click();

            await new Promise(resolve =>
                setTimeout(resolve, 1000)
            );

        } else {

            console.log(
                `[AUTO LOGIN ${this.browserType}] LOGIN / REGISTER button not found.`
            );
        }

        // ======================================
        // AFTER MENU / BUTTON CLICK
        // FIND LOGIN FORM
        // ======================================
        try {

            await this.page.waitForSelector(
                'input[formcontrolname="userid"]',
                {
                    visible: true,
                    timeout: 10000
                }
            );

            console.log(
                `[AUTO LOGIN ${this.browserType}] Login window opened successfully.`
            );

        } catch (error) {

            throw new Error(
                `[${this.browserType}] Login window open nahi hua.`
            );
        }
    }

    // ==========================================
    // USERNAME FIELD
    // ==========================================
    const usernameSelector =
        'input[formcontrolname="userid"]';

    await this.page.waitForSelector(
        usernameSelector,
        {
            visible: true,
            timeout: 15000
        }
    );

    await this.page.click(
        usernameSelector
    );

    await this.page.evaluate(
        (selector) => {

            const input =
                document.querySelector(selector);

            if (input) {

                input.value = '';

                input.dispatchEvent(
                    new Event('input', {
                        bubbles: true
                    })
                );

                input.dispatchEvent(
                    new Event('change', {
                        bubbles: true
                    })
                );
            }

        },
        usernameSelector
    );

    await this.page.type(
        usernameSelector,
        username,
        {
            delay: 30
        }
    );

    console.log(
        `[AUTO LOGIN ${this.browserType}] Username filled.`
    );

    // ==========================================
    // PASSWORD FIELD
    // ==========================================
    const passwordSelector =
        'input[formcontrolname="password"]';

    await this.page.waitForSelector(
        passwordSelector,
        {
            visible: true,
            timeout: 15000
        }
    );

    await this.page.click(
        passwordSelector
    );

    await this.page.evaluate(
        (selector) => {

            const input =
                document.querySelector(selector);

            if (input) {

                input.value = '';

                input.dispatchEvent(
                    new Event('input', {
                        bubbles: true
                    })
                );

                input.dispatchEvent(
                    new Event('change', {
                        bubbles: true
                    })
                );
            }

        },
        passwordSelector
    );

    await this.page.type(
        passwordSelector,
        password,
        {
            delay: 30
        }
    );

    console.log(
        `[AUTO LOGIN ${this.browserType}] Password filled.`
    );

    // ==========================================
    // CAPTCHA / SIGN IN MANUAL
    // ==========================================
    console.log(
    `[AUTO LOGIN ${this.browserType}] Username/password filled.`
);

// ==========================================
// CLICK SIGN IN
// ==========================================

const signInSelector =
    'button.search_btn.train_Search.train_Search_custom_hover';

await this.page.waitForSelector(
    signInSelector,
    {
        visible: true,
        timeout: 15000
    }
);

console.log(
    `[AUTO LOGIN ${this.browserType}] SIGN IN button found.`
);

try {

    await this.page.evaluate(
        (selector) => {

            const button =
                document.querySelector(selector);

            if (!button) {
                throw new Error(
                    'SIGN IN button not found.'
                );
            }

            button.scrollIntoView({
                block: 'center',
                inline: 'center'
            });

            button.dispatchEvent(
                new MouseEvent(
                    'click',
                    {
                        bubbles: true,
                        cancelable: true,
                        view: window
                    }
                )
            );
        },
        signInSelector
    );

    console.log(
        `[AUTO LOGIN ${this.browserType}] SIGN IN clicked.`
    );

} catch (signInError) {

    console.error(
        `[AUTO LOGIN ${this.browserType}] SIGN IN click failed:`,
        signInError.message
    );

    throw new Error(
        `[${this.browserType}] SIGN IN button click nahi ho saka.`
    );
}

this.sendProgress(
    'Login',
    'Username/password filled. SIGN IN clicked. Please complete CAPTCHA/OTP manually if required.',
    20
);
}

    // ==========================================
    // LOAD SESSION
    // ==========================================
    loadSession() {
        if (!fs.existsSync(this.sessionFilePath)) {
            throw new Error('session.json file nahi mili. Pehle login karein.');
        }

        let rawData;
        try {
            rawData = fs.readFileSync(this.sessionFilePath, 'utf8');
        } catch (error) {
            throw new Error(`session.json read nahi ho saki: ${error.message}`);
        }

        if (!rawData || !rawData.trim()) {
            throw new Error('session.json empty hai.');
        }

        try {
            return JSON.parse(rawData);
        } catch (error) {
            throw new Error(`session.json valid JSON nahi hai: ${error.message}`);
        }
    }

    // ==========================================
    // LOAD COOKIES
    // ==========================================
    async loadCookies() {

    // External browser ka actual session first
    if (this.page && !this.page.isClosed()) {
        try {

            const cookies = await this.page.cookies(
                'https://www.irctc.co.in'
            );

            if (cookies && cookies.length) {

                const cookieString = cookies
                    .map(c => `${c.name}=${c.value}`)
                    .join('; ');

                console.log(
                    `[SESSION ${this.browserType}] Live browser cookies loaded.`
                );

                return cookieString;
            }

        } catch (e) {
            console.warn(
                `[SESSION ${this.browserType}] Live browser cookie read failed:`,
                e.message
            );
        }
    }

    // Browser cookie unavailable -> browser-specific session file
    try {

        if (fs.existsSync(this.sessionFilePath)) {

            const rawData =
                fs.readFileSync(
                    this.sessionFilePath,
                    'utf8'
                );

            if (rawData.trim()) {

                const sessionData =
                    JSON.parse(rawData);

                if (sessionData.cookies) {

                    console.log(
                        `[SESSION ${this.browserType}] Saved cookies loaded.`
                    );

                    return String(
                        sessionData.cookies
                    ).trim();
                }
            }
        }

    } catch (e) {
        console.warn(
            `[SESSION ${this.browserType}] Saved session read failed:`,
            e.message
        );
    }

    throw new Error(
        `[${this.browserType}] Cookies nahi mili. Please IRCTC par login karein.`
    );
}

    // ==========================================
    // AUTO-UPDATE COOKIES FROM RESPONSE
    // ==========================================
    updateCookiesFromResponse(response) {
        try {
            const setCookieHeader = response.headers.get('set-cookie');
            if (!setCookieHeader) {
                return;
            }

            let existingCookies = '';
            try {
                const sessionData = this.loadSession();
                existingCookies = sessionData.cookies || '';
            } catch (e) {}

            const cookieMap = new Map();
            existingCookies.split(';').forEach(c => {
                const parts = c.trim().split('=');
                if (parts.length >= 2) {
                    const key = parts[0].trim();
                    const val = parts.slice(1).join('=').trim();
                    if (key) {
                        cookieMap.set(key, val);
                    }
                }
            });

            let newCookiesList = [];
            if (typeof response.headers.getSetCookie === 'function') {
                newCookiesList = response.headers.getSetCookie();
            } else {
                newCookiesList = [setCookieHeader];
            }

            newCookiesList.forEach(cookieStr => {
                if (!cookieStr) return;
                const mainPart = cookieStr.split(';')[0];
                const parts = mainPart.trim().split('=');
                if (parts.length >= 2) {
                    const key = parts[0].trim();
                    const val = parts.slice(1).join('=').trim();
                    if (key) {
                        cookieMap.set(key, val);
                    }
                }
            });

            const updatedCookiesArray = [];
            cookieMap.forEach((val, key) => {
                updatedCookiesArray.push(`${key}=${val}`);
            });

            const finalCookieString = updatedCookiesArray.join('; ');
            if (finalCookieString) {
                this.saveSession({
    cookies: finalCookieString,
    browserType: this.browserType
});
            }
        } catch (err) {
            console.warn('[SESSION] Failed to auto-update cookies:', err.message);
        }
    }

    // ==========================================
    // CAPTCHA
    // ==========================================
    async askUserForCaptcha(captchaImageSrc) {
        if (typeof this.requestCaptcha !== 'function') {
            throw new Error('CAPTCHA handler configured nahi hai.');
        }

        console.log('[CAPTCHA] User se CAPTCHA input maanga ja raha hai...');
        this.sendProgress('CAPTCHA', 'Waiting for user captcha input...', 85);

        const captchaText = await this.requestCaptcha(captchaImageSrc || null);
        const value = String(captchaText || '').trim();

        if (!value) {
            throw new Error('CAPTCHA enter nahi kiya gaya.');
        }

        return value;
    }

    // ==========================================
    // CAPTCHA ERROR DETECTION
    // ==========================================
    isCaptchaError(errorData, status) {
        let text = '';
        if (typeof errorData === 'string') {
            text = errorData;
        } else {
            try {
                text = JSON.stringify(errorData || {});
            } catch {
                text = '';
            }
        }

        text = text.toLowerCase();
        return (
    text.includes('captcha') ||
    text.includes('verification') ||
    text.includes('challenge')
);
    }

    // ==========================================
    // CAPTCHA SOURCE
    // ==========================================
    getCaptchaSource(data) {
        if (!data || typeof data !== 'object') {
            return null;
        }
        return data.captchaUrl || data.captchaImage || data.captcha || null;
    }

    // ==========================================
    // COMMON HEADERS
    // ==========================================
    async getHeaders(cookies, referer) {

    let jwtToken = '';

    // Actual Chrome / Edge / Brave page ka token
    if (this.page && !this.page.isClosed()) {

        try {

            jwtToken = await this.page.evaluate(() => {

                return (
                    localStorage.getItem('jwtToken') ||
                    localStorage.getItem('token') ||
                    localStorage.getItem('user') ||
                    ''
                );

            });

        } catch (e) {

            console.warn(
                `[JWT ${this.browserType}] localStorage read failed:`,
                e.message
            );
        }
    }

    const headers = {

        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',

        'Accept':
            'application/json, text/plain, */*',

        'Accept-Language':
            'en-US,en;q=0.9',

        'Referer':
            referer ||
            'https://www.irctc.co.in/nget/booking/train-list',

        'Origin':
            'https://www.irctc.co.in',

        'Content-Type':
            'application/json',

        'Connection':
            'keep-alive',

        'Client-Device-Id':
            'WEB',

        'Sec-Fetch-Dest':
            'empty',

        'Sec-Fetch-Mode':
            'cors',

        'Sec-Fetch-Site':
            'same-origin',

        'X-Requested-With':
            'XMLHttpRequest',

        'Cookie':
            cookies || ''
    };

    if (jwtToken) {
        headers.Authorization =
            `Bearer ${jwtToken}`;
    }

    return headers;
}

   
    // ==========================================
    // SAFE RESPONSE PARSER
    // ==========================================
    async parseResponse(response) {
        try {
            const rawText = typeof response.text === 'function' ? await response.text() : response.text;
            
            console.log('[API] Response Status:', response.status);
            console.log('[API] Raw length:', rawText ? rawText.length : 0);

            if (!rawText || rawText.trim() === '') {
                console.warn('[API] Warning: Response body completely empty.');
                return null;
            }

            if (rawText.trim().startsWith('<')) {
                console.error('[API] Error: Received HTML instead of JSON. Possible Akamai block or redirect:', rawText.substring(0, 150));
                return null;
            }

            return JSON.parse(rawText);
        } catch (err) {
            console.error('[API] Parse error:', err.message);
            return null;
        }
    }

    // ==========================================
    // VALIDATE RESPONSE
    // ==========================================
    validateResponse(response, stepName) {
        if (!response) {
            throw new Error(`${stepName}: response object nahi mila.`);
        }

        if (response.status === 0) {
            throw new Error(`${stepName}: HTTP status 0. Network/browser request failed.`);
        }

        if (response.status < 200 || response.status >= 300) {
            throw new Error(`${stepName}: HTTP ${response.status}`);
        }
    }

    // ==========================================
    // TRAIN SEARCH
    // ==========================================
    async searchTrains(enquiryData) {
        if (!enquiryData || typeof enquiryData !== 'object') {
            throw new Error('Train search data invalid hai.');
        }

        const cookies = await this.loadCookies();
        const url = 'https://www.irctc.co.in/eticketing/protected/rcs/trainlitchk';
        const headers = await this.getHeaders(
    cookies,
    'https://www.irctc.co.in/nget/booking/train-list'
);

        let response = null;
let lastError = null;

const maxAttempts = 3;

for (let attempt = 1; attempt <= maxAttempts; attempt++) {

    try {

        console.log(
            `[API] Train search attempt ${attempt}/${maxAttempts}`
        );

        response = await this.safeFetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(enquiryData),
            timeout: 30000
        });

        // Successful HTTP response
        if (
            response &&
            response.status >= 200 &&
            response.status < 300
        ) {
            break;
        }

        // Authentication / verification response:
        // blindly retry mat karo.
        if (
            response &&
            (
                response.status === 401 ||
                response.status === 403
            )
        ) {
            break;
        }

        lastError = new Error(
            `Train search HTTP ${response?.status || 0}`
        );

        if (attempt < maxAttempts) {

            const retryDelay =
                this.getRetryDelay(
                    attempt,
                    1000,
                    5000
                );

            console.warn(
                `[API] Temporary failure. Retrying after ${retryDelay}ms...`
            );

            await this.delay(retryDelay);
        }

    } catch (error) {

        lastError = error;

        if (attempt >= maxAttempts) {
            break;
        }

        const retryDelay =
            this.getRetryDelay(
                attempt,
                1000,
                5000
            );

        console.warn(
            `[API] Request error. Retry after ${retryDelay}ms:`,
            error.message
        );

        await this.delay(retryDelay);
    }
}

if (!response) {
    throw (
        lastError ||
        new Error('Train search request failed.')
    );
}

this.validateResponse(
    response,
    'Train search'
);
        const responseData = await this.parseResponse(response);

        if (responseData === null) {
            throw new Error('Train search response empty hai.');
        }

        return responseData;
    }

    // ==========================================
    // 1. CHECK AVAILABILITY AND FARE (BROWSER CONTEXT)
    // ==========================================
    async checkAvailabilityAndFare(bookingData) {
        this.sendProgress('Step 1', 'Checking train availability & fare...', 15);
        await this.delay(2000);

        const jDate = bookingData.journeyDate || bookingData.date;
        const fromStn = bookingData.fromStation;
        const toStn = bookingData.toStation;
        const classTp = bookingData.classType || "SL";
        const quotaCd = bookingData.quota || "GN";
        const trainNo = bookingData.trainNo;

        if (!this.page || this.page.isClosed()) {
    throw new Error(`[${this.browserType}] External browser page available nahi hai availability check ke liye.`);
}

        console.log('[BROWSER FETCH] Running POST availability check inside Electron window context...');

        const script = `
            (async () => {
                try {
                    // JWT Token fetch karne ka logic
                    let token = localStorage.getItem("jwt") || localStorage.getItem("token") || sessionStorage.getItem("jwt") || "";
                    if (!token) {
                        for (let i = 0; i < localStorage.length; i++) {
                            let k = localStorage.key(i);
                            let v = localStorage.getItem(k);
                            if (v && typeof v === 'string' && v.includes("eyJ")) {
                                token = v;
                                break;
                            }
                        }
                    }
                    token = token ? token.replace(/["\\\\\\r\\n]/g, '').trim() : "";
                    if (token && !token.startsWith('Bearer')) {
                        token = 'Bearer ' + token;
                    }

                    const url = "https://www.irctc.co.in/eticketing/protected/mapps1/avlFarenquiry/${trainNo}/${jDate}/${fromStn}/${toStn}/${classTp}/${quotaCd}/N";
                    const payload = {
                        classCode: "${classTp}",
                        concessionBooking: false,
                        fromStnCode: "${fromStn}",
                        ftBooking: false,
                        isLogedinReq: true,
                        journeyDate: "${jDate}",
                        loyaltyRedemptionBooking: false,
                        moreThanOneDay: true,
                        paymentFlag: "N",
                        quotaCode: "${quotaCd}",
                        returnJourney: false,
                        ticketType: "E",
                        toStnCode: "${toStn}",
                        trainNumber: "${trainNo}"
                    };

const stealthHeaders = {
                        "Accept": "application/json, text/plain, */*",
                        "Accept-Language": "en-US,en;q=0.9",
                        "Cache-Control": "no-cache",
                        "Pragma": "no-cache",
                        "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
                        "Sec-Ch-Ua-Mobile": "?0",
                        "Sec-Ch-Ua-Platform": '"Windows"',
                        "Sec-Fetch-Site": "same-origin",
                        "Sec-Fetch-Mode": "cors",
                        "Sec-Fetch-Dest": "empty",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
                    };

                    const response = await fetch(url, {
                        method: "POST",
                        headers: {
                        ...stealthHeaders,    
                        "Content-Type": "application/json; charset=UTF-8",
                            "Accept": "application/json, text/plain, */*",
                            "Accept-Language": "en-US,en;q=0.9",
                            "Client-Device-Id": "WEB",
                            "Greq": String(new Date().getTime()),
                            "Authorization": token,
                            "jwttoken": token.replace('Bearer ', '')
                        },
                        credentials: "include",
                        body: JSON.stringify(payload)
                    });
                    
                    const text = await response.text();
                    return { status: response.status, body: text };
                } catch (err) {
                    return { status: 0, error: err.message };
                }
            })();
        `;

        let maxRetries = 3;
        let attempt = 0;

        while (attempt < maxRetries) {
            attempt++;
            try {
                console.log(`[DEBUG] Browser-context POST avlFarenquiry attempt ${attempt} of ${maxRetries}...`);
                // Yeh naya code ensure karega ki request usi External Browser par chale jisme aapne login kiya hai
let result;

if (!this.page || this.page.isClosed()) {
    throw new Error(`[${this.browserType}] External browser page available nahi hai.`);
}

result = await this.page.evaluate(script);
                console.log(`1. Browser POST avlFarenquiry status (Attempt ${attempt}):`, result ? result.status : 0);

                if (!result || result.status !== 200 || !result.body) {
                    if (attempt < maxRetries) {
                        await this.delay(2000);
                        continue;
                    }
                    throw new Error('avlFarenquiry browser POST response empty ya invalid hai.');
                }

                return JSON.parse(result.body);
            } catch (error) {
                if (attempt >= maxRetries) throw error;
                await this.delay(2000);
            }
        }

        throw new Error('avlFarenquiry POST failed after maximum retries.');
    }

    // ==========================================
    // 2. ALTERNATE AVAILABILITY ENQUIRY
    // ==========================================
    async checkAlternateAvailability(bookingData) {
        this.sendProgress('Step 2', 'Checking alternate train availability...', 30);
        await this.delay(2000);

        if (!this.page || this.page.isClosed()) {
    throw new Error(
        `[${this.browserType}] External browser page available nahi hai alternate availability check ke liye.`
    );
}

        const script = `
            (async () => {
                try {
                    const url = "https://www.irctc.co.in/eticketing/protected/mapps1/altAvlEnq/TC";
                    const payload = {
                        concessionBooking: false,
                        currentBooking: "false",
                        destStn: "${bookingData.toStation}",
                        flexiFlag: false,
                        ftBooking: false,
                        handicapFlag: false,
                        jrnyClass: "",
                        jrnyDate: "${bookingData.journeyDate}",
                        loyaltyRedemptionBooking: false,
                        quotaCode: "${bookingData.quota}",
                        srcStn: "${bookingData.fromStation}",
                        ticketType: "E"
                    };

                    const response = await fetch(url, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json; charset=UTF-8",
                            "Accept": "application/json, text/plain, */*",
                            "Accept-Language": "en-US,en;q=0.9",
                            "Client-Device-Id": "WEB",
                            "Greq": String(new Date().getTime())
                        },
                        body: JSON.stringify(payload)
                    });
                    
                    const text = await response.text();
                    return { status: response.status, body: text };
                } catch (err) {
                    return { status: 0, error: err.message };
                }
            })();
        `;

        let maxRetries = 3;
        let attempt = 0;

        while (attempt < maxRetries) {
            attempt++;
            try {
                // Yeh naya code ensure karega ki request usi External Browser par chale jisme aapne login kiya hai
let result;

if (!this.page || this.page.isClosed()) {
    throw new Error(
        `[${this.browserType}] External browser page available nahi hai.`
    );
}

result = await this.page.evaluate(script);

                if (!result || result.status !== 200 || !result.body) {
                    if (attempt < maxRetries) {
                        await this.delay(2000);
                        continue;
                    }
                    throw new Error('altAvlEnq browser response empty ya invalid hai.');
                }
                return JSON.parse(result.body);
            } catch (error) {
                if (attempt >= maxRetries) throw error;
                await this.delay(2000);
            }
        }

        throw new Error('altAvlEnq failed after maximum retries.');
    }

    // ==========================================
    // 3. MASTER PASSENGER LIST ENQUIRY
    // ==========================================
    async getMasterPassengerList() {
        this.sendProgress('Step 3', 'Loading master passenger list...', 45);
        await this.delay(2000);

        if (!this.page || this.page.isClosed()) return null;

        const script = `
            (async () => {
                try {
                    let token = localStorage.getItem("jwt") || localStorage.getItem("token") || sessionStorage.getItem("jwt") || "";
                    if (!token) {
                        for (let i = 0; i < localStorage.length; i++) {
                            let k = localStorage.key(i);
                            let v = localStorage.getItem(k);
                            if (v && typeof v === 'string' && v.includes("eyJ")) {
                                token = v;
                                break;
                            }
                        }
                    }
                    token = token ? token.replace(/["\\\\\\r\\n]/g, '').trim() : "";
                    if (token && !token.startsWith('Bearer')) {
                        token = 'Bearer ' + token;
                    }

                    const res = await fetch("https://www.irctc.co.in/eticketing/protected/mapps1/masterpsgnlistenquiry", {
                        method: "GET",
                        headers: {
                            "Accept": "application/json, text/plain, */*",
                            "Client-Device-Id": "WEB",
                            "Greq": String(Date.now()),
                            "Authorization": token,
                            "jwttoken": token.replace('Bearer ', '')
                        },
                        credentials: "include"
                    });
                    const text = await res.text();
                    return { status: res.status, body: text };
                } catch(e) {
                    return { status: 500, body: "", error: e.toString() };
                }
            })();
        `;

        try {
           // Yeh naya code ensure karega ki request usi External Browser par chale jisme aapne login kiya hai
let result;

if (!this.page || this.page.isClosed()) {
    throw new Error(
        `[${this.browserType}] External browser page available nahi hai.`
    );
}

result = await this.page.evaluate(script);

            if (result && result.status === 200 && result.body) {
                const parsed = JSON.parse(result.body);
                if (Array.isArray(parsed)) return parsed;
                if (parsed && Array.isArray(parsed.masterPassengerList)) return parsed.masterPassengerList;
            }
        } catch (error) {}

        return null;
    }

    
    async finalFareAndPassengerEnquiry(bookingData) {
    this.sendProgress('Step 4', 'Executing full automated booking flow...', 65);
    await this.delay(2000);

    const passengers = Array.isArray(bookingData.passengers) ? bookingData.passengers : [];
    if (!passengers.length) throw new Error('Passenger list empty hai.');
    if (!this.win || !this.win.webContents) throw new Error('Browser window reference available nahi hai.');

    const backendRealFare = String(bookingData.realFare || bookingData.fare || "0");
    const targetTrainNo = String(bookingData.trainNo || "");

    const rawPayload = JSON.stringify({
    targetTrainNo: targetTrainNo,
    passengers: passengers,
    realFare: backendRealFare,
    fromStation: bookingData.fromStation || '',
    toStation: bookingData.toStation || '',
    journeyDate: bookingData.journeyDate || '',

    // CLASS FORM SE BROWSER TAK
    trainClass: String(
        bookingData.trainClass ||
        bookingData.classType ||
        bookingData.class ||
        'SL'
    ).trim().toUpperCase(),

    // QUOTA FORM SE BROWSER TAK
    quota: String(
        bookingData.quota || ''
    ).trim().toUpperCase(),

    // MOBILE FORM SE BROWSER TAK
    mobile: String(
    bookingData.mobile ||
    bookingData.passengerMobile ||
    ''
).trim(),

payment: String(
    bookingData.payment ||
    bookingData.paymentType ||
    bookingData.paymentMethod ||
    ''
).trim().toUpperCase()
});

console.log(
    '[CLASS PAYLOAD] Sending class:',
    JSON.parse(rawPayload).trainClass
);

console.log(
    '[QUOTA PAYLOAD] Sending quota:',
    JSON.parse(rawPayload).quota
);

console.log(
    '[PAYMENT PAYLOAD] Sending payment:',
    JSON.parse(rawPayload).payment
);

const base64Payload = Buffer.from(rawPayload).toString('base64');

    const browserSideAutomationTask = async function(base64Data) {
        var payload = JSON.parse(atob(base64Data));
        var diagnosticLogs = [];
        try {
            var currentUrl = window.location.href;
            diagnosticLogs.push("Current Browser URL: " + currentUrl);

            // --- YAHAN FIX KAREIN ---
            // Agar browser IRCTC par nahi hai, toh pehle wahan jayein aur wait karein
            if (window.location.href.indexOf('irctc.co.in') === -1) {
                diagnosticLogs.push("Navigating to IRCTC train search page...");
                window.location.href = "https://www.irctc.co.in/nget/train-search";
                
                // Page load hone ke liye 5-6 second ka proper wait karein
                await new Promise(function(r) { setTimeout(r, 2000); });
            } else {
                // Agar pehle se IRCTC par hai, tab bhi thoda sthir hone ka wait dein
                await new Promise(function(r) { setTimeout(r, 500); });
            }

            // 1. Fill Stations
            diagnosticLogs.push("Filling From/To station details...");
            var stationInputs = Array.from(document.querySelectorAll('p-autocomplete input'));
            if (stationInputs.length < 2) {
                stationInputs = Array.from(document.querySelectorAll('input')).filter(function(input) {
                    var ph = (input.getAttribute('placeholder') || '').toUpperCase();
                    var ar = (input.getAttribute('aria-label') || '').toUpperCase();
                    return ph.indexOf('FROM') !== -1 || ph.indexOf('TO') !== -1 || ar.indexOf('FROM') !== -1 || ar.indexOf('TO') !== -1;
                });
            }

            if (stationInputs[0] && payload.fromStation) {
                stationInputs[0].click();
                stationInputs[0].focus();
                stationInputs[0].value = payload.fromStation;
                stationInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
                stationInputs[0].dispatchEvent(new Event('keyup', { bubbles: true }));
                await new Promise(function(r) { setTimeout(r, 500); });
                
                var panel = document.querySelector('ul.ui-autocomplete-items, ul.p-autocomplete-items, .ui-autocomplete-panel, .p-autocomplete-panel');
                if (panel) {
                    var firstItem = panel.querySelector('li');
                    if (firstItem) firstItem.click();
                }
                await new Promise(function(r) { setTimeout(r, 500); });
            }

            var targetToInput = stationInputs[1] || stationInputs[0];
            if (targetToInput && payload.toStation) {
                targetToInput.click();
                targetToInput.focus();
                targetToInput.value = payload.toStation;
                targetToInput.dispatchEvent(new Event('input', { bubbles: true }));
                targetToInput.dispatchEvent(new Event('keyup', { bubbles: true }));
                await new Promise(function(r) { setTimeout(r, 500); });

                var panel2 = document.querySelector('ul.ui-autocomplete-items, ul.p-autocomplete-items, .ui-autocomplete-panel, .p-autocomplete-panel');
                if (panel2) {
                    var firstItem2 = panel2.querySelector('li');
                    if (firstItem2) firstItem2.click();
                }
                await new Promise(function(r) { setTimeout(r, 500); });
            }

            // 2. Journey Date - Smart Month Navigation & Popup Clicker
            if (payload.journeyDate) {
                var rawDate = String(payload.journeyDate).trim();
                diagnosticLogs.push("Processing Journey Date: " + rawDate);
                
                var targetYear, targetMonthIndex, targetDay;
                if (rawDate.indexOf('-') !== -1) {
                    var parts = rawDate.split('-');
                    if (parts[0].length === 4) {
                        targetYear = parts[0];
                        targetMonthIndex = parseInt(parts[1], 10) - 1;
                        targetDay = parseInt(parts[2], 10);
                    } else {
                        targetDay = parseInt(parts[0], 10);
                        targetMonthIndex = parseInt(parts[1], 10) - 1;
                        targetYear = parts[2];
                    }
                } else if (rawDate.indexOf('/') !== -1) {
                    var parts = rawDate.split('/');
                    if (parts[2].length === 4) {
                        targetDay = parseInt(parts[0], 10);
                        targetMonthIndex = parseInt(parts[1], 10) - 1;
                        targetYear = parts[2];
                    } else {
                        targetYear = parts[0];
                        targetMonthIndex = parseInt(parts[1], 10) - 1;
                        targetDay = parseInt(parts[2], 10);
                    }
                } else if (rawDate.length === 8) {
                    targetYear = rawDate.substring(0, 4);
                    targetMonthIndex = parseInt(rawDate.substring(4, 6), 10) - 1;
                    targetDay = parseInt(rawDate.substring(6, 8), 10);
                }

                if (targetYear && !isNaN(targetMonthIndex) && !isNaN(targetDay)) {
                    diagnosticLogs.push("Target: Day " + targetDay + ", Month index " + targetMonthIndex + ", Year " + targetYear);

                    var calendarTrigger = document.querySelector('p-calendar button') || document.querySelector('p-calendar input') || document.querySelector('.ui-calendar button');
                    if (calendarTrigger) {
                        calendarTrigger.click();
                        await new Promise(function(r) { setTimeout(r, 500); });

                        var monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
                        var targetMonthName = monthNames[targetMonthIndex];
                        
                        var navAttempts = 0;
                        while (navAttempts < 12) {
                            var monthEl = document.querySelector('.ui-datepicker-month, .p-datepicker-month');
                            var yearEl = document.querySelector('.ui-datepicker-year, .p-datepicker-year');
                            
                            if (monthEl && yearEl) {
                                var currentMonthText = (monthEl.innerText || monthEl.textContent || '').trim();
                                var currentYearText = (yearEl.innerText || yearEl.textContent || '').trim();
                                
                                if (currentMonthText.indexOf(targetMonthName) !== -1 && currentYearText == targetYear) {
                                    break;
                                }
                            }

                            var nextBtn = document.querySelector('.ui-datepicker-next, .p-datepicker-next');
                            if (nextBtn) {
                                nextBtn.click();
                                await new Promise(function(r) { setTimeout(r, 200); });
                            } else {
                                break;
                            }
                            navAttempts++;
                        }

                        await new Promise(function(r) { setTimeout(r, 200); });

                        var dayCells = Array.from(document.querySelectorAll('.ui-datepicker-calendar td a, .p-datepicker-calendar td span, .p-datepicker-calendar td a, td.ng-star-inserted a, .ui-state-default'));
                        var targetCell = dayCells.find(function(cell) {
                            var dayText = parseInt((cell.innerText || cell.textContent || '').trim(), 10);
                            return dayText === targetDay && !cell.classList.contains('p-disabled') && !cell.classList.contains('ui-state-disabled');
                        });

                        if (targetCell) {
                            targetCell.click();
                            diagnosticLogs.push("Journey Date successfully selected from calendar: " + targetDay + " " + targetMonthName + " " + targetYear);
                            await new Promise(function(r) { setTimeout(r, 500); });
                        } else {
                            diagnosticLogs.push("WARNING: Specific day cell nahi mila, fallback input use kar rahe hain.");
                            var dateInput = document.querySelector('p-calendar input');
                            if (dateInput) {
                                dateInput.removeAttribute('readonly');
                                var formattedDate = (targetDay < 10 ? '0' + targetDay : targetDay) + '/' + ((targetMonthIndex + 1) < 10 ? '0' + (targetMonthIndex + 1) : (targetMonthIndex + 1)) + '/' + targetYear;
                                dateInput.value = formattedDate;
                                dateInput.dispatchEvent(new Event('input', { bubbles: true }));
                                dateInput.dispatchEvent(new Event('change', { bubbles: true }));
                            }
                        }
                    }
                }
            }

            console.log("CHECK PAYLOAD:", typeof payload !== 'undefined' ? payload : "payload is undefined!");

// 2.5. Select Quota
var wanted = String(payload.quota || "").trim().toUpperCase();

if (wanted === "PT")
    wanted = "PREMIUM TATKAL";
else if (wanted === "TQ")
    wanted = "TATKAL";
else if (wanted === "GN")
    wanted = "GENERAL";

diagnosticLogs.push("Selecting Quota: " + wanted);

try {
    var quotaDropdown =
        document.querySelector('p-dropdown[formcontrolname="journeyQuota"]') ||
        document.querySelector('p-dropdown[formcontrolname="quota"]') ||
        document.querySelector('#journeyQuota');

    if (!quotaDropdown) throw new Error("Quota dropdown nahi mila.");

    (quotaDropdown.querySelector('.p-dropdown, .ui-dropdown') || quotaDropdown).click();
    await new Promise(r => setTimeout(r, 500));

    var items = Array.from(document.querySelectorAll(
        '.p-dropdown-panel li, .ui-dropdown-panel li, .p-dropdown-item, .ui-dropdown-item'
    ));

    var target = items.find(el =>
        (el.innerText || el.textContent || "").trim().toUpperCase() === wanted
    );

    if (!target) throw new Error("Option nahi mila: " + wanted);

    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    target.click();

    await new Promise(r => setTimeout(r, 500));

    var selected =
        (quotaDropdown.querySelector('.p-dropdown-label, .ui-dropdown-label')?.innerText || "")
        .trim().toUpperCase();

    diagnosticLogs.push("Quota selected value: " + selected);

    if (!selected.includes(wanted))
        throw new Error("Quota select verify nahi hua.");

    diagnosticLogs.push("Quota successfully selected: " + wanted);

} catch (e) {
    diagnosticLogs.push("Quota selection FAILED: " + e.message);
    return {
        success: false,
        error: "Quota select nahi hua: " + e.message,
        logs: diagnosticLogs
    };
}

            // 3. Click Search Trains
diagnosticLogs.push("Clicking 'Search Trains' button...");

var searchBtn = null;
var attempts = 0;

while (attempts < 15) {

    searchBtn = Array.from(
        document.querySelectorAll('button')
    ).find(function(b) {

        var t = (
            b.innerText ||
            b.textContent ||
            ''
        ).trim();

        return (
            t === 'Search Trains' ||
            t.indexOf('Search') !== -1
        );
    });

    if (searchBtn && !searchBtn.disabled) {
        break;
    }

    await new Promise(function(r) {
        setTimeout(r, 300);
    });

    attempts++;
}

if (searchBtn && !searchBtn.disabled) {

    try {
        searchBtn.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
        });
    } catch (e) {}

    await new Promise(function(r) {
        setTimeout(r, 200);
    });

    searchBtn.click();

    diagnosticLogs.push(
        "Search Trains clicked successfully."
    );

} else {

    return {
        success: false,
        error: 'Search Trains button nahi mila ya disabled hai.',
        logs: diagnosticLogs
    };
}


// =========================================================
// 4. WAIT FOR TRAIN LIST + EXACT TRAIN
// =========================================================

diagnosticLogs.push(
    "Waiting for train list and searching for exact train number: " +
    payload.targetTrainNo
);

var bookNowClicked = false;
var targetCard = null; 
var classSelectionCompleted = false;

attempts = 0;

while (attempts < 60 && !bookNowClicked) {

    // -----------------------------------------------------
    // Find exact train card
    // -----------------------------------------------------

    var trainCards = Array.from(
        document.querySelectorAll(
            'div.train-heading, ' +
            'div.train-avl-col, ' +
            '.form-group, ' +
            'p-accordionTab'
        )
    );

    targetCard = null;

    for (var c = 0; c < trainCards.length; c++) {

        var cardText =
            trainCards[c].innerText ||
            trainCards[c].textContent ||
            '';

        if (
            cardText.indexOf(
                String(payload.targetTrainNo)
            ) !== -1
        ) {

            targetCard = trainCards[c];
            break;
        }
    }


    // -----------------------------------------------------
    // Fallback exact train search
    // -----------------------------------------------------

    if (!targetCard) {

        var allElements = Array.from(
            document.querySelectorAll(
                'span, div, b, strong'
            )
        );

        var matchedEl = allElements.find(function(el) {

            var text = (
                el.innerText ||
                el.textContent ||
                ''
            ).trim();

            return (
                text === String(payload.targetTrainNo) ||
                text.indexOf(
                    '(' +
                    String(payload.targetTrainNo) +
                    ')'
                ) !== -1
            );
        });

        if (matchedEl) {

            targetCard =
                matchedEl.closest(
                    'div.train-avl-col'
                ) ||
                matchedEl.closest(
                    '.ng-star-inserted'
                ) ||
                (
                    matchedEl.parentElement &&
                    matchedEl.parentElement.parentElement
                );
        }
    }


    // -----------------------------------------------------
    // TARGET TRAIN FOUND
    // -----------------------------------------------------

    if (targetCard) {

        diagnosticLogs.push(
            "Exact target train card found for number: " +
            payload.targetTrainNo
        );

        // =========================================================
// TATKAL OPENING-TIME WAIT
// =========================================================

var quotaForTiming = String(
    payload.quota || ''
).trim().toUpperCase();

var classForTiming = String(
    payload.trainClass || 'SL'
).trim().toUpperCase();

var isTatkalQuota =
    quotaForTiming === 'TQ' ||
    quotaForTiming === 'PT' ||
    quotaForTiming === 'TATKAL' ||
    quotaForTiming === 'PREMIUM TATKAL';

if (isTatkalQuota) {

    // AC Tatkal = 10:00 AM
    // Non-AC Tatkal = 11:00 AM
    //
    // AC classes:
    // 1A, 2A, 3A, 3E, CC, EC, EA
    //
    // Non-AC:
    // SL, FC, 2S

    var acClasses = [
        '1A',
        '2A',
        '3A',
        '3E',
        'CC',
        'EC',
        'EA'
    ];

    var isACClass =
        acClasses.indexOf(classForTiming) !== -1;

    var tatkalHour =
        isACClass ? 10 : 11;

    var tatkalMinute = 0;
    var tatkalSecond = 0;

    diagnosticLogs.push(
        "Tatkal timing detected."
    );

    diagnosticLogs.push(
        "Selected class: " +
        classForTiming
    );

    diagnosticLogs.push(
        "Tatkal opening time: " +
        (
            tatkalHour === 10
                ? "10:00:00 AM"
                : "11:00:00 AM"
        )
    );


    // -----------------------------------------------------
    // WAIT UNTIL EXACT OPENING TIME
    // -----------------------------------------------------

    while (true) {

        var now = new Date();

        var currentSeconds =
            now.getHours() * 3600 +
            now.getMinutes() * 60 +
            now.getSeconds();

        var openingSeconds =
            tatkalHour * 3600 +
            tatkalMinute * 60 +
            tatkalSecond;

        var remaining =
            openingSeconds - currentSeconds;


        if (remaining <= 0) {
            break;
        }


        // Log only once per 10 seconds
        // so console spam na ho.
        if (
            remaining <= 10 ||
            remaining % 10 === 0
        ) {

            var mins = Math.floor(
                remaining / 60
            );

            var secs =
                remaining % 60;

            diagnosticLogs.push(
                "Waiting for Tatkal opening: " +
                mins +
                "m " +
                secs +
                "s"
            );
        }


        // Last 5 seconds:
        // much shorter polling
        if (remaining <= 5) {

            await new Promise(function(r) {
                setTimeout(r, 100);
            });

        } else {

            await new Promise(function(r) {
                setTimeout(r, 500);
            });
        }
    }


    diagnosticLogs.push(
        "Tatkal opening time reached. " +
        "Now selecting journey date card..."
    );
}

  // =========================================================
        // 🔥 FIX: DATE OF JOURNEY / AVAILABILITY BOX SELECTION
        // (Sirf targetCard ke andar search karega taaki doosri train touch na ho)
        // =========================================================
        var dateBoxes = Array.from(targetCard.querySelectorAll('div.avl-date, div.pre-avl, div.box-avl, td, div.ng-star-inserted'));
        var targetDateBox = dateBoxes.find(function(box) {
            var bText = (box.innerText || box.textContent || '').toUpperCase();
            return (bText.indexOf('AVAILABLE') !== -1 || bText.indexOf('WL') !== -1 || bText.indexOf('RAC') !== -1 || bText.indexOf('AVL') !== -1) 
                   && bText.length < 40 
                   && box.querySelectorAll('div.avl-date, div.pre-avl').length === 0;
        });

        if (targetDateBox) {
            try { targetDateBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(e) {}
            await new Promise(function(r) { setTimeout(r, 200); });
            
            targetDateBox.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            diagnosticLogs.push("Journey date / availability box selected successfully for target train.");
            await new Promise(function(r) { setTimeout(r, 500); });
        }


        // =================================================
        // SELECT REQUESTED TRAIN CLASS
        // =================================================

        var targetClass = String(payload.trainClass || '').trim().toUpperCase();
if (!targetClass) return { success:false, error:'trainClass missing from payload', logs:diagnosticLogs };

        diagnosticLogs.push(
            "Looking for target class: " +
            targetClass
        );

        var classNames = {

            "SL": "SLEEPER",

            "3E": "AC 3 ECONOMY",

            "3A": "AC 3 TIER",

            "2A": "AC 2 TIER",

            "1A": "AC FIRST CLASS"
        };

        var wantedClassName =
            classNames[targetClass] ||
            targetClass;

        var matchedClassBox = null;


        // -------------------------------------------------
        // Find smallest actual class element
        // -------------------------------------------------

        var classCandidates = Array.from(
            targetCard.querySelectorAll(
                'button, a, label, span, div'
            )
        );

        for (
            var ci = 0;
            ci < classCandidates.length;
            ci++
        ) {

            var el = classCandidates[ci];

            var text = (
                el.innerText ||
                el.textContent ||
                ''
            )
            .replace(/\s+/g, ' ')
            .trim()
            .toUpperCase();


            var exactClassText =
                text.indexOf(
                    wantedClassName
                ) !== -1 &&
                text.indexOf(
                    '(' + targetClass + ')'
                ) !== -1;

            if (!exactClassText) {
                continue;
            }


            // Parent/container nahi chahiye
            var smallerChildren =
                Array.from(
                    el.querySelectorAll(
                        'button, a, label, span, div'
                    )
                )
                .filter(function(child) {

                    var childText = (
                        child.innerText ||
                        child.textContent ||
                        ''
                    )
                    .replace(/\s+/g, ' ')
                    .trim()
                    .toUpperCase();

                    return (
                        childText.indexOf(
                            wantedClassName
                        ) !== -1 &&
                        childText.indexOf(
                            '(' + targetClass + ')'
                        ) !== -1
                    );
                });


            if (
                smallerChildren.length > 0
            ) {
                continue;
            }


            matchedClassBox = el;
            break;
        }


        // -------------------------------------------------
        // CLASS NOT FOUND
        // -------------------------------------------------

        if (!matchedClassBox) {

            diagnosticLogs.push(
                "Class not found yet. Retrying train card..."
            );

            await new Promise(function(r) {
                setTimeout(r, 700);
            });

            attempts++;
            continue;
        }


        // -------------------------------------------------
        // REAL CLASS ELEMENT FOUND
        // -------------------------------------------------

        diagnosticLogs.push(
            "REAL class element found: " +
            (
                matchedClassBox.innerText ||
                matchedClassBox.textContent ||
                ''
            )
            .replace(/\s+/g, ' ')
            .trim()
        );

        

        try {

            matchedClassBox.scrollIntoView({
                behavior: 'smooth',
                block: 'center'
            });

        } catch (e) {}


        await new Promise(function(r) {
            setTimeout(r, 200);
        });


        // -------------------------------------------------
        // CLICK CLASS ONLY ONCE
        // -------------------------------------------------

        diagnosticLogs.push(
            "Clicking class only once: " +
            targetClass
        );

        matchedClassBox.dispatchEvent(
    new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        view: window
    })
);

matchedClassBox.dispatchEvent(
    new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        view: window
    })
);

matchedClassBox.dispatchEvent(
    new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window
    })
);

        diagnosticLogs.push(
            "Class click sent successfully: " +
            targetClass
        );


        await new Promise(function(r) {
            setTimeout(r, 500);
        });


                    // -------------------------------------------------
        // VERIFY CLASS / AVAILABILITY
        // -------------------------------------------------

        var selected = false;
        var parentSelected = false;

        // Check clicked element + parents
        var checkNode = matchedClassBox;

        for (var level = 0; level < 5 && checkNode; level++) {

            var nodeClass = String(
                checkNode.className || ''
            ).toLowerCase();

            var ariaSelected =
                checkNode.getAttribute &&
                checkNode.getAttribute('aria-selected') === 'true';

            var ariaChecked =
                checkNode.getAttribute &&
                checkNode.getAttribute('aria-checked') === 'true';

            var nodeSelected =
                nodeClass.indexOf('active') !== -1 ||
                nodeClass.indexOf('selected') !== -1 ||
                ariaSelected ||
                ariaChecked;

            if (nodeSelected) {

                if (level === 0) {
                    selected = true;
                } else {
                    parentSelected = true;
                }

                break;
            }

            checkNode = checkNode.parentElement;
        }


        // -------------------------------------------------
        // ADDITIONAL CHECK:
        // Look for selected/active class element containing
        // the exact requested class inside target card.
        // -------------------------------------------------

        if (!selected && !parentSelected) {

            var selectedElements =
                Array.from(
                    targetCard.querySelectorAll(
                        '.active, .selected, [aria-selected="true"], [aria-checked="true"]'
                    )
                );

            for (
                var si = 0;
                si < selectedElements.length;
                si++
            ) {

                var selectedText = (
                    selectedElements[si].innerText ||
                    selectedElements[si].textContent ||
                    ''
                )
                .replace(/\s+/g, ' ')
                .trim()
                .toUpperCase();

                if (
                    selectedText.indexOf(
                        '(' + targetClass + ')'
                    ) !== -1
                ) {

                    parentSelected = true;

                    diagnosticLogs.push(
                        "Selected state found on class container: " +
                        targetClass
                    );

                    break;
                }
            }
        }


        // -------------------------------------------------
        // AVAILABILITY CHECK
        // -------------------------------------------------

        var availabilityVisible = false;

        for (
            var vi = 0;
            vi < 15;
            vi++
        ) {

            var visibleText = (
                targetCard.innerText ||
                targetCard.textContent ||
                ''
            ).toUpperCase();

            if (
                visibleText.indexOf('AVL') !== -1 ||
                visibleText.indexOf('WL') !== -1 ||
                visibleText.indexOf('AVAILABLE') !== -1
            ) {

                availabilityVisible = true;
                break;
            }

            await new Promise(function(r) {
                setTimeout(r, 200);
            });
        }


        // =================================================
        // HARD CLASS SELECTION GATE
        // =================================================

        if (
            selected ||
            parentSelected
        ) {

            classSelectionCompleted = true;

            diagnosticLogs.push(
                "SUCCESS: Exact class " +
                targetClass +
                " selected successfully."
            );

        } else {

            classSelectionCompleted = false;

            diagnosticLogs.push(
                "WARNING: Class selection could not be verified."
            );

            diagnosticLogs.push(
                "Book Now BLOCKED because class is not confirmed."
            );

            await new Promise(function(r) {
                setTimeout(r, 700);
            });

            attempts++;
            continue;
        }


        // -------------------------------------------------
        // CLASS CONFIRMED
        // -------------------------------------------------

        diagnosticLogs.push(
            "CLASS GATE PASSED: " +
            targetClass +
            " -> Book Now may continue."
        );

        await new Promise(function(r) {
            setTimeout(r, 500);
        });


// =========================================================
// SAFE JOURNEY DATE CARD SELECTOR
// =========================================================

var journeyDateSelected = false;

try {

    diagnosticLogs.push(
        "Targeting journey date card..."
    );

    var jd = String(
        payload.journeyDate || ''
    ).trim();

    var targetDay = '';
    var targetMonth = '';

    var monthList = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec'
    ];

    // -------------------------------------------------
    // PARSE JOURNEY DATE
    // -------------------------------------------------

    if (jd.indexOf('-') !== -1) {

        var dashParts = jd.split('-');

        if (dashParts.length === 3) {

            if (dashParts[0].length === 4) {

                targetDay = String(
                    parseInt(dashParts[2], 10)
                );

                targetMonth = monthList[
                    parseInt(dashParts[1], 10) - 1
                ];

            } else {

                targetDay = String(
                    parseInt(dashParts[0], 10)
                );

                targetMonth = monthList[
                    parseInt(dashParts[1], 10) - 1
                ];
            }
        }

    } else if (jd.indexOf('/') !== -1) {

        var slashParts = jd.split('/');

        if (slashParts.length === 3) {

            if (slashParts[0].length === 4) {

                targetDay = String(
                    parseInt(slashParts[2], 10)
                );

                targetMonth = monthList[
                    parseInt(slashParts[1], 10) - 1
                ];

            } else {

                targetDay = String(
                    parseInt(slashParts[0], 10)
                );

                targetMonth = monthList[
                    parseInt(slashParts[1], 10) - 1
                ];
            }
        }

    } else if (jd.length === 8) {

        targetDay = String(
            parseInt(jd.substring(6, 8), 10)
        );

        targetMonth = monthList[
            parseInt(jd.substring(4, 6), 10) - 1
        ];
    }

    diagnosticLogs.push(
        "Looking for date: " +
        targetDay +
        " " +
        targetMonth
    );

    // -------------------------------------------------
    // IMPORTANT:
    // CLASS CLICK KE BAAD TRAIN CARD RE-RENDER HO SAKTA HAI.
    // ISLIYE FRESH TARGET CARD DOBARA FIND KARO.
    // -------------------------------------------------

    var freshDateCardTrain = null;

    var dateTrainCards = Array.from(
        document.querySelectorAll(
            'p-accordionTab, div.train-avl-col, div.form-group'
        )
    );

    for (var dtc = 0; dtc < dateTrainCards.length; dtc++) {

        var trainCandidate = dateTrainCards[dtc];

        var trainText = (
            trainCandidate.innerText ||
            trainCandidate.textContent ||
            ''
        );

        if (
            trainText.indexOf(
                String(payload.targetTrainNo)
            ) !== -1
        ) {

            var nestedTrainCards =
                trainCandidate.querySelectorAll(
                    'p-accordionTab, div.train-avl-col'
                );

            if (nestedTrainCards.length === 0) {

                freshDateCardTrain = trainCandidate;
                break;
            }
        }
    }

    if (freshDateCardTrain) {

    targetCard = freshDateCardTrain;

    diagnosticLogs.push(
        "Fresh target train card found after class selection."
    );

} else {

    targetCard = null;

    diagnosticLogs.push(
        "Fresh target train card not found after class selection."
    );
}

    // -------------------------------------------------
    // FIND EXACT JOURNEY DATE
    // -------------------------------------------------

    if (targetCard && targetDay && targetMonth) {

        var wantedDateText = (
            targetDay +
            ' ' +
            targetMonth
        ).toUpperCase();

        var dateCandidates = Array.from(
            targetCard.querySelectorAll('div, td, span, button, a')
        );

        // Smallest matching element prefer karo
        dateCandidates.sort(function(a, b) {
            return (
                a.querySelectorAll('*').length -
                b.querySelectorAll('*').length
            );
        });

        var exactDateElement = dateCandidates.find(function(el) {

            var txt = (
                el.innerText ||
                el.textContent ||
                ''
            )
            .replace(/\s+/g, ' ')
            .trim()
            .toUpperCase();

            var hasDate =
                txt.indexOf(wantedDateText) !== -1;

            var hasAvailability =
                txt.indexOf('AVL') !== -1 ||
                txt.indexOf('WL') !== -1 ||
                txt.indexOf('AVAILABLE') !== -1 ||
                txt.indexOf('RAC') !== -1;

            return (
                hasDate &&
                hasAvailability &&
                txt.length < 100
            );
        });

        if (exactDateElement) {

            try {
                exactDateElement.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center'
                });
            } catch (e) {}

            await new Promise(function(r) {
                setTimeout(r, 100);
            });

            exactDateElement.dispatchEvent(
                new MouseEvent(
                    'click',
                    {
                        bubbles: true,
                        cancelable: true,
                        view: window
                    }
                )
            );

            journeyDateSelected = true;

            diagnosticLogs.push(
                "Journey date selected successfully: " +
                targetDay +
                " " +
                targetMonth
            );

            await new Promise(function(r) {
                setTimeout(r, 400);
            });

        } else {

            diagnosticLogs.push(
                "Journey date NOT found: " +
                targetDay +
                " " +
                targetMonth
            );
        }
    }

} catch (dateError) {

    journeyDateSelected = false;

    diagnosticLogs.push(
        "Date selector error: " +
        (
            dateError.message ||
            dateError
        )
    );
}


// =========================================================
// SAFETY CHECK - JOURNEY DATE MUST BE SELECTED
// =========================================================

if (!journeyDateSelected) {

    diagnosticLogs.push(
        "SAFETY: Book Now blocked because journey date is not selected."
    );

    classSelectionCompleted = false;
    targetCard = null;

    attempts++;

    await new Promise(function(r) {
        setTimeout(r, 300);
    });

    continue;
}


// =================================================
// SAFETY CHECK - CLASS MUST BE SELECTED FIRST
// =================================================
if (!classSelectionCompleted) {

    diagnosticLogs.push(
        "SAFETY: Book Now blocked because class selection is not completed."
    );

    await new Promise(function(r) {
        setTimeout(r, 500);
    });

    attempts++;
    continue;
}

diagnosticLogs.push(
    "Class selection confirmed. Book Now is now allowed."
);

        diagnosticLogs.push(
            "Searching for Book Now button..."
        );


        var quotaValue = String(
            payload.quota || ''
        )
        .trim()
        .toUpperCase();


        // PT / TQ = Tatkal related quota
        var isTatkal =
            quotaValue === 'TQ' ||
            quotaValue === 'PT' ||
            quotaValue === 'TATKAL' ||
            quotaValue === 'PREMIUM TATKAL';


        if (isTatkal) {

            diagnosticLogs.push(
                "Tatkal quota detected. Book Now retry mode enabled."
            );

        } else {

            diagnosticLogs.push(
                "General quota detected. Normal Book Now flow enabled."
            );
        }


        // -------------------------------------------------
        // Retry window
        // -------------------------------------------------
        //
        // Tatkal:
        //  60 attempts x 1 sec
        //
        // General:
        //  30 attempts x 1 sec
        //
        // Isse temporary disabled/not-ready state mein
        // task immediately fail nahi hoga.
        // -------------------------------------------------

        var bookRetryLimit =
            isTatkal ? 60 : 30;


        for (
            var bTry = 0;
            bTry < bookRetryLimit;
            bTry++
        ) {

            // -------------------------------------------------
        // FRESH TARGET CARD (STRICT & SAFE TRAIN ROW FINDER)
        // -------------------------------------------------
        var freshTargetCard = null;
        
        // Sirf wahi elements lo jo sach mein ek train ki row/card hain (.ng-star-inserted hata diya hai)
        var possibleCards = Array.from(
            document.querySelectorAll(
                'p-accordionTab, div.train-avl-col, div.form-group'
            )
        );

        for (var pc = 0; pc < possibleCards.length; pc++) {
            var card = possibleCards[pc];
            var possibleText = (card.innerText || card.textContent || '');

            // Check karo ki is specific card ke andar train number hai
            if (possibleText.indexOf(String(payload.targetTrainNo)) !== -1) {
                
                // Yeh ensure karne ke liye ki yeh kisi aur badi train ka container na ho,
                // hum check karenge ki iske andar koi aur chota train card toh nahi hai.
                var subCards = card.querySelectorAll('p-accordionTab, div.train-avl-col');
                if (subCards.length === 0) {
                    freshTargetCard = card;
                    break;
                }
            }
        }

        targetCard = freshTargetCard || null;

if (bTry > 0 && targetCard) {

    // CLASS
    var retryClass = String(payload.trainClass || '').trim().toUpperCase();
    var retryClassName = classNames[retryClass] || retryClass;

    var retryClassEl = Array.from(
        targetCard.querySelectorAll('button,a,label,span,div')
    ).find(function(el) {
        var t = (el.innerText || el.textContent || '')
            .replace(/\s+/g,' ').trim().toUpperCase();

        return t.indexOf('(' + retryClass + ')') !== -1 &&
               t.indexOf(retryClassName) !== -1;
    });

    if (!retryClassEl) {
        diagnosticLogs.push("Retry: exact class nahi mila.");
        await new Promise(function(r) { setTimeout(r, 200); });
        continue;
    }

retryClassEl.click();
await new Promise(function(r) { setTimeout(r, 300); });

targetCard = Array.from(
    document.querySelectorAll('p-accordionTab, div.train-avl-col, div.form-group')
).find(function(el) {
    return (el.innerText || '').indexOf(String(payload.targetTrainNo)) !== -1 &&
           el.querySelectorAll('p-accordionTab, div.train-avl-col').length === 0;
});

// JOURNEY DATE

    // JOURNEY DATE
    var retryDateEl = Array.from(
    targetCard.querySelectorAll('div,td,span,button,a')
).sort(function(a,b) {
    return a.querySelectorAll('*').length - b.querySelectorAll('*').length;
}).find(function(el) {
        var t = (el.innerText || el.textContent || '')
            .replace(/\s+/g,' ').trim().toUpperCase();

        return t.indexOf(
            (targetDay + ' ' + targetMonth).toUpperCase()
        ) !== -1 &&
        (
            t.indexOf('AVL') !== -1 ||
            t.indexOf('WL') !== -1 ||
            t.indexOf('AVAILABLE') !== -1 ||
            t.indexOf('RAC') !== -1
        ) &&
        t.length < 80;
    });

    if (!retryDateEl) {
        diagnosticLogs.push("Retry: journey date nahi mila.");
        await new Promise(function(r) { setTimeout(r, 200); });
        continue;
    }

    retryDateEl.click();

    diagnosticLogs.push(
        "Retry: Train -> Class -> Journey Date selected."
    );

    await new Promise(function(r) { setTimeout(r, 200); });
}

            // -------------------------------------------------
            // Find Book Now
            // -------------------------------------------------

            var bookBtn =
                targetCard
                    ? Array.from(
                        targetCard.querySelectorAll(
                            'button, a'
                        )
                    )
                    .find(function(b) {

                        var t = (
                            b.innerText ||
                            b.textContent ||
                            ''
                        )
                        .trim()
                        .toUpperCase();

                        return (
                            t.indexOf(
                                'BOOK NOW'
                            ) !== -1
                        );
                    })
                    : null;


            // -------------------------------------------------
            // Check disabled
            // -------------------------------------------------

            var btnDisabled =
                bookBtn &&
                (
                    bookBtn.disabled ||
                    bookBtn.getAttribute(
                        'disabled'
                    ) !== null ||
                    bookBtn.getAttribute(
                        'aria-disabled'
                    ) === 'true' ||
                    bookBtn.classList.contains(
                        'disabled'
                    )
                );


            if (
                bookBtn &&
                !btnDisabled
            ) {

                try {

                    bookBtn.scrollIntoView({
                        behavior: 'smooth',
                        block: 'center'
                    });

                } catch (e) {}


                await new Promise(function(r) {
                    setTimeout(r, 150);
                });


                diagnosticLogs.push(
                    "Attempt " +
                    (bTry + 1) +
                    ": Clicking Book Now..."
                );


                try {

bookBtn.click();

diagnosticLogs.push(
    "Book Now click sent. Passenger page load hone ka wait..."
);

var passengerPageReached = false;

for (var waitTry = 0; waitTry < 60; waitTry++) {

    await new Promise(function(r) {
        setTimeout(r, 100);
    });

    var currentUrl = window.location.href;

    if (
        currentUrl.indexOf('psgninput') !== -1 ||
        document.querySelector(
            'input[formcontrolname="passengerName"]'
        )
    ) {
        passengerPageReached = true;
        break;
    }
}

if (passengerPageReached) {
    bookNowClicked = true;

    diagnosticLogs.push(
        "Passenger page reached after Book Now click."
    );

    break;
} else {

    var retryText =
        (document.body.innerText || '').toLowerCase();

    var highLoadPopup =
        retryText.includes('high load') ||
        retryText.includes('unable to process') ||
        retryText.includes('please retry');

    if (highLoadPopup) {

        diagnosticLogs.push(
            "High Load / Unable to Process popup detected."
        );

        var closeRetry =
    document.querySelector(
        'a.ui-toast-close-icon.pi.pi-times'
    );

if (closeRetry) {

    try {
        closeRetry.click();

        diagnosticLogs.push(
            "IRCTC error toast closed successfully."
        );

    } catch (e) {

        diagnosticLogs.push(
            "Error toast close failed: " +
            (e.message || e)
        );
    }

} else {

    diagnosticLogs.push(
        "IRCTC error toast close button not found."
    );
}

        await new Promise(function(r) {
            setTimeout(r, 1000);
        });

        diagnosticLogs.push(
            "Popup closed. Next attempt will reselect Train -> Class -> Date."
        );

    } else {

        diagnosticLogs.push(
            "Book Now failed. Next attempt will reselect Train -> Class -> Date."
        );
    }

    classSelectionCompleted = false;
    targetCard = null;

    await new Promise(function(r) {
        setTimeout(r, 100);
    });

    continue;
}


                } catch (clickError) {

                    diagnosticLogs.push(
                        "Book Now click error: " +
                        (
                            clickError.message ||
                            clickError
                        ) +
                        " — retrying..."
                    );
                }

            } else {

                diagnosticLogs.push(
                    "Book Now not ready/disabled. Retry " +
                    (bTry + 1) +
                    "/" +
                    bookRetryLimit
                );
            }


            // -------------------------------------------------
            // IMPORTANT:
            // 1 second wait between retries
            // -------------------------------------------------

            await new Promise(function(r) {
                setTimeout(r, 1000);
            });
        }


        // -------------------------------------------------
        // BOOK NOW SUCCESS
        // -------------------------------------------------

        if (bookNowClicked) {

            diagnosticLogs.push(
                "Book Now process completed successfully."
            );

            break;
        }


        // -------------------------------------------------
        // Retry window finished
        // -------------------------------------------------

        diagnosticLogs.push(
            "Book Now retry window finished for current train card."
        );


    } else {

        // =================================================
        // TRAIN CARD NOT FOUND YET
        // =================================================

        diagnosticLogs.push(
            "Target train not found yet. Waiting for train list..."
        );

        await new Promise(function(r) {
            setTimeout(r, 700);
        });
    }


    attempts++;

    await new Promise(function(r) {
        setTimeout(r, 500);
    });
}


// =========================================================
// FINAL BOOK NOW RESULT
// =========================================================

if (!bookNowClicked) {

    return {
        success: false,
        error:
            'Target train (' +
            payload.targetTrainNo +
            ') ya uska Book Now button retry window mein nahi mila.',
        logs: diagnosticLogs
    };
}


diagnosticLogs.push(
    "Target train booking flow moved forward successfully."
);


            // 5. Passenger Page + Form
diagnosticLogs.push(
    "Waiting for passenger input form to load..."
);

var navSuccess = false;
var nameInputs = [];

for (var i = 0; i < 60; i++) {

    await new Promise(function(r) {
        setTimeout(r, 500);
    });

    var currentUrl = window.location.href;

    nameInputs = Array.from(
        document.querySelectorAll(
            'input[formcontrolname="passengerName"], input[placeholder*="Full Name"], input[placeholder*="Govt"]'
        )
    );

    if (
        currentUrl.indexOf('psgninput') !== -1 &&
        nameInputs.length > 0
    ) {
        navSuccess = true;
        break;
    }
}

if (!navSuccess || nameInputs.length === 0) {
    return {
        success: false,
        error: 'Passenger page/form load nahi hua.',
        logs: diagnosticLogs
    };
}

diagnosticLogs.push(
    "Passenger page + form ready."
);

            diagnosticLogs.push("Filling passenger details using native setters & PrimeNG handlers...");
 var passengers = payload.passengers || [];
 
 if (passengers.length === 0) {
     passengers = [{ name: "Passenger 1", age: 30, gender: "M" }];
 }

 for (var i = 0; i < passengers.length; i++) {
     var p = passengers[i];

     // 1. Agar pehla passenger nahi hai, toh "Add Passenger" button par click karein taaki naya row aaye
     if (i > 0) {
         var addBtn = document.querySelector('span.add-passenger, a.add-passenger, span.fa-plus-circle, button[label*="Add Passenger"]');
         // Fallback text search for Add Passenger button
         if (!addBtn) {
             var clickableElements = document.querySelectorAll('span, a, button');
             for (var ce = 0; ce < clickableElements.length; ce++) {
                 var txt = (clickableElements[ce].innerText || '').trim().toLowerCase();
                 if (txt === 'add passenger' || txt.indexOf('add passenger') !== -1) {
                     addBtn = clickableElements[ce];
                     break;
                 }
             }
         }

         if (addBtn) {
             addBtn.click();
             diagnosticLogs.push("Clicked 'Add Passenger' for row " + (i + 1));
             await new Promise(function(r) { setTimeout(r, 500); }); // Naye row ke load hone ka wait
         } else {
             diagnosticLogs.push("Warning: 'Add Passenger' button nahi mila, checking existing inputs...");
         }
     }

     // Har iteration par fresh inputs query karein taaki naye rows detect ho sakein
     var nameInputs = Array.from(document.querySelectorAll('input[formcontrolname="passengerName"], input[placeholder*="Full Name"], input[placeholder*="Govt"]'));
     var ageInputs = Array.from(document.querySelectorAll('input[formcontrolname="passengerAge"], input[placeholder*="Age"]'));
     var genderControls = document.querySelectorAll('select[formcontrolname="passengerGender"]');

     // 2. Passenger Name
     var nameInput = nameInputs[i];
     if (nameInput) {
         nameInput.focus();
         var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
         nativeInputValueSetter.call(nameInput, p.name || p.passengerName || "Test Passenger");
         nameInput.dispatchEvent(new Event('input', { bubbles: true }));
         nameInput.dispatchEvent(new Event('change', { bubbles: true }));
         nameInput.dispatchEvent(new Event('blur', { bubbles: true }));
         diagnosticLogs.push("Filled name for passenger " + (i + 1) + ": " + (p.name || p.passengerName));
         await new Promise(function(r) { setTimeout(r, 200); });
     }

     // 3. Passenger Age
     var ageInput = ageInputs[i];
     if (ageInput) {
         ageInput.focus();
         var nativeAgeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
         nativeAgeValueSetter.call(ageInput, String(p.age || p.passengerAge || 30));
         ageInput.dispatchEvent(new Event('input', { bubbles: true }));
         ageInput.dispatchEvent(new Event('change', { bubbles: true }));
         ageInput.dispatchEvent(new Event('blur', { bubbles: true }));
         diagnosticLogs.push("Filled age for passenger " + (i + 1));
         await new Promise(function(r) { setTimeout(r, 200); });
     }

                // 3. Gender Select - Native HTML SELECT + Angular
try {
    diagnosticLogs.push(
        "Selecting gender for passenger " + (i + 1) + "..."
    );

    var genderValue = String(
        p.gender ||
        p.passengerGender ||
        "M"
    ).trim().toUpperCase();

    var wantedGender = "M";

    if (
        genderValue === "F" ||
        genderValue.indexOf("FEMALE") === 0
    ) {
        wantedGender = "F";
    } else if (
        genderValue === "T" ||
        genderValue.indexOf("TRANS") === 0
    ) {
        wantedGender = "T";
    }

    diagnosticLogs.push(
        "Requested gender code: " + wantedGender
    );

    // ---------------------------------------------------------
    // FIND NATIVE SELECT
    // ---------------------------------------------------------

    var genderSelect = null;

    // First: exact passengerGender control
    var genderControls = document.querySelectorAll(
        'select[formcontrolname="passengerGender"]'
    );

    if (genderControls.length > i) {
        genderSelect = genderControls[i];

        diagnosticLogs.push(
            "Gender SELECT found using passengerGender"
        );
    }

    // Second: any SELECT with passengerGender attribute
    if (!genderSelect) {

        var allSelects = Array.from(
            document.querySelectorAll("select")
        );

        diagnosticLogs.push(
            "Total SELECT elements: " +
            allSelects.length
        );

        // Try to identify gender select from nearby text
        for (
            var si = 0;
            si < allSelects.length;
            si++
        ) {

            var selectEl = allSelects[si];

            var nearbyText = "";

            if (selectEl.parentElement) {
                nearbyText +=
                    " " +
                    (selectEl.parentElement.innerText || "");
            }

            if (
                selectEl.parentElement &&
                selectEl.parentElement.parentElement
            ) {
                nearbyText +=
                    " " +
                    (
                        selectEl.parentElement.parentElement.innerText ||
                        ""
                    );
            }

            nearbyText = nearbyText
                .replace(/\s+/g, " ")
                .toUpperCase();

            if (
                nearbyText.indexOf("GENDER") !== -1
            ) {
                genderSelect = selectEl;

                diagnosticLogs.push(
                    "Gender SELECT identified using nearby GENDER text"
                );

                break;
            }
        }
    }

    // ---------------------------------------------------------
    // SELECT NOT FOUND
    // ---------------------------------------------------------

    if (!genderSelect) {

        diagnosticLogs.push(
            "ERROR: Native gender SELECT nahi mila passenger " +
            (i + 1)
        );

    } else {

        diagnosticLogs.push(
            "Native gender SELECT FOUND for passenger " +
            (i + 1)
        );

        genderSelect.scrollIntoView({
            behavior: "auto",
            block: "center"
        });

        await new Promise(function (resolve) {
            setTimeout(resolve, 200);
        });

        // -----------------------------------------------------
        // INSPECT OPTIONS
        // -----------------------------------------------------

        var options = Array.from(
            genderSelect.options || []
        );

        diagnosticLogs.push(
            "Gender SELECT options: " +
            options.length
        );

        var selectedOption = null;

        for (
            var oi = 0;
            oi < options.length;
            oi++
        ) {

            var opt = options[oi];

            var optText = String(
                opt.text ||
                opt.innerText ||
                ""
            )
                .trim()
                .toUpperCase();

            var optValue = String(
                opt.value || ""
            )
                .trim()
                .toUpperCase();

            diagnosticLogs.push(
                "Gender option " +
                oi +
                ": text=[" +
                optText +
                "] value=[" +
                optValue +
                "]"
            );

            // Accept different possible values
            var isMatch = false;

            if (wantedGender === "M") {

                isMatch =
                    optText === "MALE" ||
                    optText === "M" ||
                    optValue === "M" ||
                    optValue === "MALE";

            } else if (wantedGender === "F") {

                isMatch =
                    optText === "FEMALE" ||
                    optText === "F" ||
                    optValue === "F" ||
                    optValue === "FEMALE";

            } else if (wantedGender === "T") {

                isMatch =
                    optText === "TRANSGENDER" ||
                    optText === "T" ||
                    optValue === "T" ||
                    optValue === "TRANSGENDER";
            }

            if (isMatch) {
                selectedOption = opt;
                break;
            }
        }

        // -----------------------------------------------------
        // SET VALUE
        // -----------------------------------------------------

        if (selectedOption) {

            diagnosticLogs.push(
                "Gender option matched: " +
                (
                    selectedOption.text ||
                    selectedOption.value
                )
            );

            var nativeSelectSetter =
                Object.getOwnPropertyDescriptor(
                    window.HTMLSelectElement.prototype,
                    "value"
                ).set;

            nativeSelectSetter.call(
                genderSelect,
                selectedOption.value
            );

            // Angular input/change detection
            genderSelect.dispatchEvent(
                new Event("input", {
                    bubbles: true
                })
            );

            genderSelect.dispatchEvent(
                new Event("change", {
                    bubbles: true
                })
            );

            genderSelect.dispatchEvent(
                new Event("blur", {
                    bubbles: true
                })
            );

            await new Promise(function (resolve) {
                setTimeout(resolve, 200);
            });

            diagnosticLogs.push(
                "Gender selected successfully: " +
                (
                    selectedOption.text ||
                    selectedOption.value
                ) +
                " for passenger " +
                (i + 1)
            );

        } else {

            diagnosticLogs.push(
                "ERROR: Male/Female option native SELECT mein nahi mili."
            );
        }
    }

} catch (err) {

    diagnosticLogs.push(
        "Gender error: " +
        (
            err && err.message
                ? err.message
                : String(err)
        )
    );
}

await new Promise(function (resolve) {
    setTimeout(resolve, 200);
});
 }
            
// 4. Mobile Number Entry (Using Angular Native Setter)
var mobileVal = payload.mobile || '';
var mobileFilled = false;

try {
    diagnosticLogs.push("Filling mobile number...");

    // Mobile number retrieve karne ke saare possible sources check kar rahe hain
    var mobileVal = (typeof bookingData !== 'undefined' && (bookingData.mobile || bookingData.passengerMobile)) ||
                (typeof data !== 'undefined' && (data.mobile || data.phone)) ||
                (typeof config !== 'undefined' && (config.mobile || config.phone)) ||
                (typeof payload !== 'undefined' && payload.mobile) || 
                (typeof p !== 'undefined' && p.mobile) || 
                (typeof passengerMobile !== 'undefined' && passengerMobile) || '';
                
    var mobileInput =
        document.querySelector('input[formcontrolname*="mobile" i]') ||
        document.querySelector('input[id*="mobile" i]') ||
        document.querySelector('input[name*="mobile" i]') ||
        document.querySelector('input[placeholder*="mobile" i]') ||
        document.querySelector('input[type="tel"]');

    if (!mobileInput) {
        throw new Error("Mobile field nahi mila.");
    }

    mobileInput.focus();

    // Angular Native Setter ka use karke value clear aur set karna (jaise Age mein kiya tha)
    var nativeMobileSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    
    // Pehle clear karo
    nativeMobileSetter.call(mobileInput, "");
    mobileInput.dispatchEvent(new Event("input", { bubbles: true }));
    mobileInput.dispatchEvent(new Event("change", { bubbles: true }));
    
    await new Promise(function(r) { setTimeout(r, 200); });

    // Ab naya mobile number set karo
    nativeMobileSetter.call(mobileInput, String(mobileVal));

    // Angular ke reactive forms ko trigger karne ke liye events
    mobileInput.dispatchEvent(new Event("input", { bubbles: true }));
    mobileInput.dispatchEvent(new Event("change", { bubbles: true }));
    mobileInput.dispatchEvent(new Event("blur", { bubbles: true }));

    await new Promise(function(r) { setTimeout(r, 200); });

    diagnosticLogs.push("Mobile field value after fill: " + mobileInput.value);

    if (mobileInput.value.length > 0) {
        mobileFilled = true;
        diagnosticLogs.push("Mobile number filled successfully: " + mobileInput.value);
    } else {
        diagnosticLogs.push("Mobile number set nahi hua.");
    }

} catch (mErr) {
    diagnosticLogs.push("Mobile error: " + mErr.message);
}

await new Promise(function(r) {
    setTimeout(r, 200);
});

// =========================================================
// BOOK ONLY IF CONFIRMED BERTH - AUTO TICK
// =========================================================

try {

    var confirmCheckbox =
        Array.from(
            document.querySelectorAll(
                'input[type="checkbox"], input[type="radio"]'
            )
        )
        .find(function(el) {

            if (
                !el ||
                !el.isConnected
            ) {
                return false;
            }


            if (el.checked) {
                return false;
            }


            var parentText =
                el.parentElement
                    ? (
                        el.parentElement.innerText ||
                        el.parentElement.textContent ||
                        ''
                    )
                    : '';


            return (
                String(parentText)
                    .toUpperCase()
                    .indexOf(
                        'BOOK ONLY IF'
                    ) !== -1 ||
                String(parentText)
                    .toUpperCase()
                    .indexOf(
                        'CONFIRMED'
                    ) !== -1
            );
        });


    if (confirmCheckbox) {

        confirmCheckbox.click();

        await automationWait(150);


        if (confirmCheckbox.checked) {

            diagnosticLogs.push(
                "Book only if confirmed berth option automatically tick kar diya gaya."
            );

        } else {

            diagnosticLogs.push(
                "WARNING: Confirmation checkbox click hua lekin checked state verify nahi hui."
            );
        }

    } else {

        diagnosticLogs.push(
            "Confirmation berth checkbox directly nahi mila. Label fallback check karenge."
        );


        var confirmLabel =
            Array.from(
                document.querySelectorAll(
                    'label, span, div'
                )
            )
            .find(function(el) {

                if (
                    !el ||
                    !el.isConnected
                ) {
                    return false;
                }


                var txt =
                    String(
                        el.innerText ||
                        el.textContent ||
                        ''
                    )
                    .toUpperCase();


                return (
                    txt.indexOf(
                        'BOOK ONLY IF'
                    ) !== -1 ||
                    txt.indexOf(
                        'CONFIRMED BERTHS'
                    ) !== -1
                );
            });


        if (confirmLabel) {

            try {

                confirmLabel.click();

                await automationWait(150);


                var verifiedCheckbox =
                    Array.from(
                        document.querySelectorAll(
                            'input[type="checkbox"], input[type="radio"]'
                        )
                    )
                    .find(function(el) {

                        if (
                            !el ||
                            !el.isConnected
                        ) {
                            return false;
                        }


                        var txt =
                            el.parentElement
                                ? String(
                                    el.parentElement.innerText ||
                                    el.parentElement.textContent ||
                                    ''
                                ).toUpperCase()
                                : '';


                        return (
                            txt.indexOf(
                                'BOOK ONLY IF'
                            ) !== -1 ||
                            txt.indexOf(
                                'CONFIRMED'
                            ) !== -1
                        );
                    });


                if (
                    verifiedCheckbox &&
                    verifiedCheckbox.checked
                ) {

                    diagnosticLogs.push(
                        "Confirmation option label se select aur verify ho gaya."
                    );

                } else {

                    diagnosticLogs.push(
                        "WARNING: Confirmation label click ke baad checked state verify nahi hui."
                    );
                }

            } catch (labelError) {

                diagnosticLogs.push(
                    "Confirmation label click error: " +
                    (
                        labelError.message ||
                        labelError
                    )
                );
            }

        } else {

            diagnosticLogs.push(
                "Confirmation berth option nahi mila."
            );
        }
    }

} catch (confError) {

    diagnosticLogs.push(
        "Confirmation option warning: " +
        (
            confError.message ||
            confError
        )
    );
}
            
            // 6. UPI Payment Selection & Booking (Strictly BHIM/UPI Lower Option)
diagnosticLogs.push("Selecting BHIM/UPI payment option precisely...");
var upiSelected = false;

try {
    // 1. Sabhi radio buttons ya labels ko dhoondho jo payment options ke hain
    var paymentLabels = Array.from(document.querySelectorAll('label, span, div.row, p-radiobutton, .p-radiobutton'));
    
    // 2. Us element ko filter karo jisme exact "Pay through BHIM/UPI" ya "BHIM/UPI" ho aur upar wale CC/UPI_CC ka zikr na ho
    var targetUpiLabel = paymentLabels.find(function(el) {
        var text = (el.innerText || el.textContent || '').trim();
        // Yeh ensure karega ki hum credit card / UPI_CC wale option ko chhod kar sirf BHIM/UPI wala lein
        return (text.includes('Pay through BHIM/UPI') || text === 'BHIM/UPI') && !text.includes('UPI_CC') && !text.includes('Credit & Debit');
    });

    if (targetUpiLabel) {
        var radioInput = targetUpiLabel.querySelector('input') || targetUpiLabel.closest('p-radiobutton, .p-radiobutton')?.querySelector('input') || targetUpiLabel;
        
        if (radioInput) {
            radioInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await new Promise(function(r) { setTimeout(r, 200); });
            
            // Mouse events aur click trigger karo taaki Angular form update ho jaye
            ['mousedown', 'mouseup', 'click'].forEach(function(eventType) {
                radioInput.dispatchEvent(new MouseEvent(eventType, {
                    view: window,
                    bubbles: true,
                    cancelable: true,
                    buttons: 1
                }));
            });
            
            radioInput.click();
            radioInput.dispatchEvent(new Event('change', { bubbles: true }));
            radioInput.dispatchEvent(new Event('input', { bubbles: true }));
            
            upiSelected = true;
            diagnosticLogs.push("Successfully selected the lower BHIM/UPI payment option.");
        }
    }

    // Agar upar wale tareeqe se na ho, toh specific DOM index/position se target karo
    if (!upiSelected) {
        var allRadios = Array.from(document.querySelectorAll('input[type="radio"]'));
        // Aam taur par BHIM/UPI wala radio button list mein dusra ya teesra hota hai
        if (allRadios.length > 1) {
            // Niche wale radio button ko target karne ke liye aakhri ya specific index try karo
            var upiRadio = allRadios.find(function(r) {
                var parentText = (r.closest('label, div, p-radiobutton')?.innerText || '').toUpperCase();
                return parentText.includes('BHIM/UPI') && !parentText.includes('UPI_CC');
            });
            
            if (upiRadio) {
                upiRadio.click();
                upiRadio.dispatchEvent(new Event('change', { bubbles: true }));
                upiSelected = true;
                diagnosticLogs.push("BHIM/UPI selected using radio fallback.");
            }
        }
    }

} catch (payErr) {
    diagnosticLogs.push("UPI Selection Error: " + payErr.message);
}

if (!upiSelected) {
    diagnosticLogs.push("WARNING: BHIM/UPI option could not be selected!");
}

await new Promise(function(r) { setTimeout(r, 500); });

        
// =================================================
// FIRST CONTINUE
// =================================================

var continueBtn1 = Array.from(
    document.querySelectorAll('button')
).find(function(b) {

    var t = (b.innerText || '')
        .trim()
        .toLowerCase();

    return (
        t.indexOf('continue') !== -1 &&
        b.offsetParent !== null &&
        !b.disabled
    );
});

if (!continueBtn1) {

    return {
        success: false,
        error: 'First continue button nahi mila.',
        logs: diagnosticLogs
    };
}

continueBtn1.click();

diagnosticLogs.push(
    "First Continue button clicked."
);


// =================================================
// FIRST CONTINUE RETRY
// =================================================

var firstRetry = 0;
var firstRetryLimit = 60;
var firstWaitCycles = 0;
var firstWaitCycleLimit = 120;

for (;;) {
    firstWaitCycles++;

    if (firstWaitCycles > firstWaitCycleLimit) {
        return {
            success: false,
            error: 'First Continue page response timeout.',
            logs: diagnosticLogs
        };
    }

    await new Promise(function(r) {
        setTimeout(r, 500);
    });

    var txt =
        (document.body.innerText || '').toLowerCase();

    var popup =
        txt.includes('high load') ||
        txt.includes('unable to process') ||
        txt.includes('please retry');

    if (popup) {

        firstRetry++;

        diagnosticLogs.push(
            "First Continue error popup. Retry " +
            firstRetry +
            "/" +
            firstRetryLimit
        );

        var close =
    document.querySelector(
        'a.ui-toast-close-icon.pi.pi-times'
    );

if (close) {
    try {
        close.click();

        diagnosticLogs.push(
            "Error toast close button clicked successfully."
        );
    } catch (e) {}

    await new Promise(function(r) {
        setTimeout(r, 500);
    });
}

        if (firstRetry >= firstRetryLimit) {

            return {
                success: false,
                error:
                    'First Continue failed after 60 retries.',
                logs: diagnosticLogs
            };
        }

        // Fresh Continue button
        continueBtn1 =
            Array.from(
                document.querySelectorAll('button')
            ).find(function(b) {

                var t =
                    (b.innerText || '')
                    .trim()
                    .toLowerCase();

                return (
                    t.indexOf('continue') !== -1 &&
                    b.offsetParent !== null &&
                    !b.disabled
                );
            });

        if (continueBtn1) {

            continueBtn1.click();

            diagnosticLogs.push(
                "First Continue retry clicked."
            );
        }

        continue;
    }

    var wait =
        txt.includes('please wait') ||
        txt.includes('processing');

    var passengerPage =
        document.querySelector(
            'input[formcontrolname="passengerName"]'
        );

    var reviewPage =
        /review|booking details|passenger details/i.test(txt);

    if (
        !wait &&
        (passengerPage || reviewPage)
    ) {
        break;
    }
}


// =================================================
// SECOND CONTINUE
// =================================================

diagnosticLogs.push(
    "First Continue processing complete. Searching next Continue..."
);

var continueBtn2 = null;

var secondFindRetry = 0;
var secondFindLimit = 60;
var secondFindWaitCycles = 0;
var secondFindWaitCycleLimit = 120;

for (;;) {
    secondFindWaitCycles++;

    if (secondFindWaitCycles > secondFindWaitCycleLimit) {
        return {
            success: false,
            error: 'Second Continue search timeout.',
            logs: diagnosticLogs
        };
    }

    await new Promise(function(r) {
        setTimeout(r, 500);
    });

    var txt2 =
        (document.body.innerText || '').toLowerCase();

    var popup2 =
        txt2.includes('high load') ||
        txt2.includes('unable to process') ||
        txt2.includes('please retry');

    if (popup2) {

        secondFindRetry++;

        diagnosticLogs.push(
            "Second Continue page error. Retry " +
            secondFindRetry +
            "/" +
            secondFindLimit
        );

        var close2 =
    document.querySelector(
        'a.ui-toast-close-icon.pi.pi-times'
    );

if (close2) {
    try {
        close2.click();

        diagnosticLogs.push(
            "Second continue error toast closed successfully."
        );
    } catch (e) {}

    await new Promise(function(r) {
        setTimeout(r, 500);
    });
}

        if (secondFindRetry >= secondFindLimit) {

            return {
                success: false,
                error:
                    'Second Continue button nahi mila after 60 retries.',
                logs: diagnosticLogs
            };
        }

        continue;
    }

    continueBtn2 =
        Array.from(
            document.querySelectorAll('button')
        ).find(function(b) {

            var t =
                (b.innerText || '')
                .trim()
                .toLowerCase();

            return (
                t.indexOf('continue') !== -1 &&
                b.offsetParent !== null &&
                !b.disabled
            );
        });

    if (continueBtn2) {
        break;
    }
}


continueBtn2.click();

diagnosticLogs.push(
    "Second Continue button clicked."
);


// =================================================
// SECOND CONTINUE RETRY
// =================================================

var secondRetry = 0;
var secondRetryLimit = 60;
var secondWaitCycles = 0;
var secondWaitCycleLimit = 120;

for (;;) {
    secondWaitCycles++;

    if (secondWaitCycles > secondWaitCycleLimit) {
        return {
            success: false,
            error: 'Second Continue processing timeout.',
            logs: diagnosticLogs
        };
    }

    await new Promise(function(r) {
        setTimeout(r, 500);
    });

    var txt3 =
        (document.body.innerText || '').toLowerCase();

    var popup3 =
        txt3.includes('high load') ||
        txt3.includes('unable to process') ||
        txt3.includes('please retry');

    if (popup3) {

        secondRetry++;

        diagnosticLogs.push(
            "Second Continue error popup. Retry " +
            secondRetry +
            "/" +
            secondRetryLimit
        );

        var close3 =
    document.querySelector(
        'a.ui-toast-close-icon.pi.pi-times'
    );

if (close3) {
    try {
        close3.click();

        diagnosticLogs.push(
            "Second continue error toast closed successfully."
        );
    } catch (e) {}

    await new Promise(function(r) {
        setTimeout(r, 300);
    });
}

        if (secondRetry >= secondRetryLimit) {

            return {
                success: false,
                error:
                    'Second Continue failed after 60 retries.',
                logs: diagnosticLogs
            };
        }

        // Fresh Continue button
        var retryBtn =
            Array.from(
                document.querySelectorAll('button')
            ).find(function(b) {

                var t =
                    (b.innerText || '')
                    .trim()
                    .toLowerCase();

                return (
                    t.indexOf('continue') !== -1 &&
                    b.offsetParent !== null &&
                    !b.disabled
                );
            });

        if (retryBtn) {

            retryBtn.click();

            diagnosticLogs.push(
                "Second Continue retry clicked."
            );
        }

        continue;
    }

    if (
        !txt3.includes('please wait') &&
        !txt3.includes('processing')
    ) {
        break;
    }
}


// =================================================
// FINAL PAYMENT PAGE LOADER COMPLETE
// =================================================

diagnosticLogs.push(
    "Continue processing completed."
);

// =====================================================
// PAYMENT METHOD SELECTION - NEW IRCTC PAYMENT PAGE
// =====================================================

var selectedPayment =
    String(
        payload.payment ||
        payload.paymentType ||
        payload.paymentMethod ||
        ''
    )
    .trim()
    .toUpperCase();

diagnosticLogs.push(
    "Selected payment from payload: " +
    selectedPayment
);


// =====================================================
// PAYMENT MUST BE PRESENT
// =====================================================

if (!selectedPayment) {

    return {
        success: false,
        error:
            'Payment type payload mein empty hai. Form se PAYTM QR / PHONEPE QR value nahi aa rahi.',
        logs: diagnosticLogs
    };
}


// =====================================================
// NORMALIZE PAYMENT TYPE
// =====================================================

var paymentIsPaytm =
    selectedPayment === 'PAYTM QR' ||
    selectedPayment === 'PAYTMQR' ||
    selectedPayment.indexOf('PAYTM') === 0;

var paymentIsPhonePe =
    selectedPayment === 'PHONEPE QR' ||
    selectedPayment === 'PHONEPEQR' ||
    selectedPayment.indexOf('PHONEPE') === 0;

var paymentIsIPay =
    selectedPayment === 'IPAY QR' ||
    selectedPayment === 'IPAYQR' ||
    selectedPayment.indexOf('IPAY') === 0;    

if (!paymentIsPaytm && !paymentIsPhonePe && !paymentIsIPay) {

    return {
        success: false,
        error:
            'Unknown payment type payload mein aa raha hai: ' +
            selectedPayment,
        logs: diagnosticLogs
    };
}

// =====================================================
// IRCTC IPAY
// =====================================================
if (paymentIsIPay) {

    diagnosticLogs.push("STEP: IRCTC iPay select kar rahe hain.");

    var ipay = Array.from(document.querySelectorAll('div.bank-type'))
    .find(function(el) {
        return (el.innerText || el.textContent || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toUpperCase()
            .includes('IRCTC IPAY');
    });

if (!ipay) {
    return {
        success: false,
        error: 'IRCTC iPay option nahi mila.',
        logs: diagnosticLogs
    };
}

ipay.click();

await new Promise(function(r) {
    setTimeout(r, 100);
});

    var ipayNew = Array.from(document.querySelectorAll(
    'div.border-all.link'
)).find(function(el) {
    return (el.innerText || el.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase()
        .startsWith('IRCTC IPAY NEW');
});

if (!ipayNew) {
    return {
        success: false,
        error: 'IRCTC iPay New option nahi mila.',
        logs: diagnosticLogs
    };
}

ipayNew.click();

diagnosticLogs.push(
    "SUCCESS: IRCTC iPay New selected."
);

await new Promise(function(r) {
    setTimeout(r, 100);
});
}

var providerName = paymentIsPaytm ? 'PAYTM' : paymentIsPhonePe ? 'PHONEPE' : 'IPAY';

diagnosticLogs.push(
    "Normalized payment: " +
    (paymentIsPaytm ? 'PAYTM QR' : paymentIsPhonePe ? 'PHONEPE QR' : 'IPAY QR')
);

diagnosticLogs.push(
    "Payment provider target: " +
    providerName
);


// =====================================================
// PAYTM / PHONEPE
// PEHLE MULTIPLE PAYMENT SERVICE CLICK HOGA.
// =====================================================

if (paymentIsIPay) {
    diagnosticLogs.push("IRCTC iPay selected. Multiple Payment Service skip.");
} else {

diagnosticLogs.push(
    providerName + " QR selected."
);

diagnosticLogs.push(
    "STEP 1: Pehle Multiple Payment Service select karenge."
);


// =================================================
// FIND MULTIPLE PAYMENT SERVICE
// =================================================

var multiplePaymentService = null;

for (var multiTry = 0; multiTry < 30; multiTry++) {

    try {

        var bankTypeElements =
            Array.from(
                document.querySelectorAll('.bank-type')
            );

        multiplePaymentService =
            bankTypeElements.find(function(el) {

                if (
                    !el ||
                    !el.isConnected ||
                    el.offsetParent === null
                ) {
                    return false;
                }

                var ariaDisabled =
                    String(
                        el.getAttribute &&
                        el.getAttribute('aria-disabled') ||
                        ''
                    )
                    .trim()
                    .toLowerCase();

                if (ariaDisabled === 'true') {
                    return false;
                }

                var txt =
                    String(
                        el.innerText ||
                        el.textContent ||
                        ''
                    )
                    .replace(/\s+/g, ' ')
                    .trim()
                    .toUpperCase();

                return txt.indexOf(
                    'MULTIPLE PAYMENT SERVICE'
                ) !== -1;
            });

        if (multiplePaymentService) {
            break;
        }

    } catch (e) {}

    await new Promise(function(resolve) {
        setTimeout(resolve, 100);
    });
}


if (!multiplePaymentService) {

    return {
        success: false,
        error:
            'Multiple Payment Service option nahi mila.',
        logs: diagnosticLogs
    };
}


diagnosticLogs.push(
    "Multiple Payment Service element found."
);


// =================================================
// ACTIVE STATE CHECK
// =================================================

function isMultiplePaymentServiceActive(el) {

    if (!el || !el.isConnected) {
        return false;
    }

    var cls =
        String(el.className || '').toLowerCase();

    var ariaSelected =
        String(
            el.getAttribute &&
            el.getAttribute('aria-selected') ||
            ''
        )
        .trim()
        .toLowerCase();

    var ariaChecked =
        String(
            el.getAttribute &&
            el.getAttribute('aria-checked') ||
            ''
        )
        .trim()
        .toLowerCase();

    return (
        cls.indexOf('bank-type-active') !== -1 ||
        cls.indexOf('selected') !== -1 ||
        cls.indexOf('active') !== -1 ||
        ariaSelected === 'true' ||
        ariaChecked === 'true'
    );
}


// =================================================
// CLICK MULTIPLE PAYMENT SERVICE
// =================================================

if (!isMultiplePaymentServiceActive(multiplePaymentService)) {

    try {

        multiplePaymentService.scrollIntoView({
            behavior: 'auto',
            block: 'center'
        });

    } catch (e) {}

    try {

        multiplePaymentService.click();

        diagnosticLogs.push(
            "SUCCESS: Multiple Payment Service clicked."
        );

    } catch (multiClickError) {

        try {

            multiplePaymentService.dispatchEvent(
                new MouseEvent('mousedown', {
                    bubbles: true,
                    cancelable: true,
                    view: window
                })
            );

            multiplePaymentService.dispatchEvent(
                new MouseEvent('mouseup', {
                    bubbles: true,
                    cancelable: true,
                    view: window
                })
            );

            multiplePaymentService.dispatchEvent(
                new MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    view: window
                })
            );

            diagnosticLogs.push(
                "SUCCESS: Multiple Payment Service clicked using mouse events."
            );

        } catch (mouseError) {

            return {
                success: false,
                error:
                    'Multiple Payment Service click failed: ' +
                    multiClickError.message,
                logs: diagnosticLogs
            };
        }
    }

} else {

    diagnosticLogs.push(
        "Multiple Payment Service already active."
    );
}


// =================================================
// WAIT FOR MULTIPLE PAYMENT SERVICE TO ACTIVATE
// =================================================

diagnosticLogs.push(
    "STEP 2: Multiple Payment Service activation verify kar rahe hain..."
);

var multipleVerified = false;

for (var multiVerifyTry = 0; multiVerifyTry < 30; multiVerifyTry++) {

    var freshMultiplePaymentService = null;

    try {

        freshMultiplePaymentService =
            Array.from(
                document.querySelectorAll('.bank-type')
            ).find(function(el) {

                if (!el || !el.isConnected) {
                    return false;
                }

                var txt =
                    String(
                        el.innerText ||
                        el.textContent ||
                        ''
                    )
                    .replace(/\s+/g, ' ')
                    .trim()
                    .toUpperCase();

                return txt.indexOf(
                    'MULTIPLE PAYMENT SERVICE'
                ) !== -1;
            });

        if (
            freshMultiplePaymentService &&
            isMultiplePaymentServiceActive(
                freshMultiplePaymentService
            )
        ) {

            multipleVerified = true;
            break;
        }

    } catch (e) {}

    await new Promise(function(resolve) {
        setTimeout(resolve, 100);
    });
}


if (multipleVerified) {

    diagnosticLogs.push(
        "SUCCESS: Multiple Payment Service selected/verified."
    );

} else {

    diagnosticLogs.push(
        "Multiple Payment Service click hua, lekin active class verification nahi mili."
    );

    diagnosticLogs.push(
        "Provider options visible hone tak wait karenge."
    );
}


// =================================================
// PROVIDER SEARCH
// =================================================

diagnosticLogs.push(
    "STEP 3: Ab " +
    providerName +
    " side option search karenge."
);

var providerElement = null;

for (var providerTry = 0; providerTry < 40; providerTry++) {

    providerElement = null;

    try {

        var providerElements =
            Array.from(
                document.querySelectorAll(
                    '.border-all.link, .col-pad a, .col-pad button, .bank-type'
                )
            );

        providerElement =
            providerElements.find(function(el) {

                if (
                    !el ||
                    !el.isConnected ||
                    el.offsetParent === null ||
                    el.disabled === true
                ) {
                    return false;
                }

                var ariaDisabled =
                    String(
                        el.getAttribute &&
                        el.getAttribute('aria-disabled') ||
                        ''
                    )
                    .trim()
                    .toLowerCase();

                if (ariaDisabled === 'true') {
                    return false;
                }

                var txt =
                    String(
                        el.innerText ||
                        el.textContent ||
                        ''
                    )
                    .replace(/\s+/g, ' ')
                    .trim()
                    .toUpperCase();

                return txt === providerName;
            });


        if (!providerElement) {

            providerElement =
                providerElements.find(function(el) {

                    if (
                        !el ||
                        !el.isConnected ||
                        el.offsetParent === null ||
                        el.disabled === true
                    ) {
                        return false;
                    }

                    var ariaDisabled =
                        String(
                            el.getAttribute &&
                            el.getAttribute('aria-disabled') ||
                            ''
                        )
                        .trim()
                        .toLowerCase();

                    if (ariaDisabled === 'true') {
                        return false;
                    }

                    var txt =
                        String(
                            el.innerText ||
                            el.textContent ||
                            ''
                        )
                        .replace(/\s+/g, ' ')
                        .trim()
                        .toUpperCase();

                    return (
                        txt.indexOf(providerName) !== -1 &&
                        txt.length <= 80
                    );
                });
        }


        if (providerElement) {
            break;
        }

    } catch (e) {}

    await new Promise(function(resolve) {
        setTimeout(resolve, 100);
    });
}


// =================================================
// PROVIDER NOT FOUND
// =================================================

if (!providerElement) {

    return {
        success: false,
        error:
            'Multiple Payment Service activate hua, lekin side mein ' +
            providerName +
            ' option nahi mila.',
        logs: diagnosticLogs
    };
}


// =================================================
// PROVIDER FOUND
// =================================================

var providerText =
    String(
        providerElement.innerText ||
        providerElement.textContent ||
        ''
    )
    .replace(/\s+/g, ' ')
    .trim();

diagnosticLogs.push(
    "SUCCESS: Actual " +
    providerName +
    " side option found."
);

diagnosticLogs.push(
    "Provider element: TAG=" +
    providerElement.tagName +
    " TEXT=" +
    providerText
);


// =================================================
// CLICK PROVIDER
// =================================================

try {

    providerElement.scrollIntoView({
        behavior: 'auto',
        block: 'center'
    });

} catch (e) {}

try {

    providerElement.click();

    diagnosticLogs.push(
        "SUCCESS: " +
        providerName +
        " provider option clicked."
    );

} catch (providerClickError) {

    try {

        providerElement.dispatchEvent(
            new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                view: window
            })
        );

        providerElement.dispatchEvent(
            new MouseEvent('mouseup', {
                bubbles: true,
                cancelable: true,
                view: window
            })
        );

        providerElement.dispatchEvent(
            new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                view: window
            })
        );

        diagnosticLogs.push(
            "SUCCESS: " +
            providerName +
            " clicked using mouse events."
        );

    } catch (mouseError) {

        return {
            success: false,
            error:
                providerName +
                ' provider click failed: ' +
                providerClickError.message,
            logs: diagnosticLogs
        };
    }
}


await new Promise(function(resolve) {
    setTimeout(resolve, 50);
});

}


diagnosticLogs.push(
    providerName +
    " selected. Ab directly Pay & Book dhoondhenge."
);


// =====================================================
// PAY & BOOK BUTTON + ERROR RETRY
// =====================================================

diagnosticLogs.push(
    "Waiting for Pay & Book button to appear..."
);

var payAndBookBtn = null;
var payBookRetry = 0;
var payBookRetryLimit = 60;

for (;;) {

    // =================================================
    // FIND FRESH PAY & BOOK BUTTON
    // =================================================

    payAndBookBtn = null;

    for (var payBookTry = 0; payBookTry < 40; payBookTry++) {

        try {

            payAndBookBtn =
                Array.from(
                    document.querySelectorAll(
                        'button, a, [role="button"]'
                    )
                ).find(function(button) {

                    if (
                        !button ||
                        !button.isConnected ||
                        button.offsetParent === null ||
                        button.disabled === true
                    ) {
                        return false;
                    }

                    var ariaDisabled =
                        String(
                            button.getAttribute &&
                            button.getAttribute(
                                'aria-disabled'
                            ) || ''
                        )
                        .trim()
                        .toLowerCase();

                    if (ariaDisabled === 'true') {
                        return false;
                    }

                    var text =
                        String(
                            button.innerText ||
                            button.textContent ||
                            ''
                        )
                        .replace(/\s+/g, ' ')
                        .trim()
                        .toLowerCase();

                    return (
                        text.indexOf('pay & book') !== -1 ||
                        text.indexOf('make payment') !== -1
                    );
                });

        } catch (e) {}

        if (payAndBookBtn) {
            break;
        }

        await new Promise(function(resolve) {
            setTimeout(resolve, 200);
        });
    }


    // =================================================
    // PAY & BOOK NOT FOUND
    // =================================================

    if (!payAndBookBtn) {

        return {
            success: false,
            error:
                'Pay & Book button nahi mila (Page load timeout).',
            logs: diagnosticLogs
        };
    }


    // =================================================
    // CLICK PAY & BOOK
    // =================================================

    try {

        payAndBookBtn.scrollIntoView({
            behavior: 'auto',
            block: 'center'
        });

    } catch (e) {}


    try {

        payAndBookBtn.click();

        diagnosticLogs.push(
            "Pay & Book click sent. Checking payment page..."
        );

    } catch (payBookClickError) {

        diagnosticLogs.push(
            "Pay & Book click failed. Retrying..."
        );

        continue;
    }


    // =================================================
    // CHECK RESULT / ERROR POPUP
    // =================================================
    var payBookRetryAlreadyCounted = false;
    var payBookSuccess = false;

    for (var payWait = 0; payWait < 20; payWait++) {

        await new Promise(function(resolve) {
            setTimeout(resolve, 500);
        });

        var payText =
            (document.body.innerText || '').toLowerCase();

        // ---------------------------------------------
        // HIGH LOAD / UNABLE / PLEASE RETRY
        // ---------------------------------------------

        var payBookPopup =
            payText.includes('high load') ||
            payText.includes('unable to process') ||
            payText.includes('please retry');

        if (payBookPopup) {

    payBookRetryAlreadyCounted = true;
    payBookRetry++;

            diagnosticLogs.push(
                "Pay & Book error popup detected. Retry " +
                payBookRetry +
                "/" +
                payBookRetryLimit
            );


            // -----------------------------------------
            // EXACT IRCTC TOAST CLOSE BUTTON
            // -----------------------------------------

            var payClose =
                document.querySelector(
                    'a.ui-toast-close-icon.pi.pi-times'
                );

            if (payClose) {

                try {

                    payClose.click();

                    diagnosticLogs.push(
                        "Pay & Book error toast closed successfully."
                    );

                } catch (e) {}

            }


            if (payBookRetry >= payBookRetryLimit) {

                return {
                    success: false,
                    error:
                        'Pay & Book failed after ' +
                        payBookRetryLimit +
                        ' retries.',
                    logs: diagnosticLogs
                };
            }


            await new Promise(function(resolve) {
                setTimeout(resolve, 300);
            });

            diagnosticLogs.push(
                "Retrying Pay & Book..."
            );

            break;
        }


        // ---------------------------------------------
        // PAYMENT / QR PAGE REACHED
        // ---------------------------------------------

        if (
            payText.includes('qr') ||
            payText.includes('payment') ||
            payText.includes('paytm') ||
            payText.includes('phonepe') ||
            payText.includes('ipay')
        ) {

            payBookSuccess = true;
            break;
        }
    }


    if (payBookSuccess) {

        diagnosticLogs.push(
            "SUCCESS: Pay & Book completed. Waiting for " +
            providerName +
            " QR payment page..."
        );

        return {
            success: true,
            paymentMethod: selectedPayment,
            totalFare: payload.realFare,
            logs: diagnosticLogs,
            message: 'Pay & Book clicked successfully.'
        };
    }


    // NO PAYMENT PAGE / NO POPUP
// RETRY PAY & BOOK
// =================================================

if (!payBookRetryAlreadyCounted) {
    payBookRetry++;
}

    diagnosticLogs.push(
        "Payment page not reached. Retrying Pay & Book " +
        payBookRetry +
        "/" +
        payBookRetryLimit
    );

    if (payBookRetry >= payBookRetryLimit) {

        return {
            success: false,
            error:
                'Pay & Book failed after ' +
                payBookRetryLimit +
                ' retries.',
            logs: diagnosticLogs
        };
    }

    await new Promise(function(resolve) {
        setTimeout(resolve, 300);
    });
}


// =====================================================
// OUTER BROWSER AUTOMATION TRY/CATCH
// =====================================================

} catch (automationError) {

    diagnosticLogs.push(
        "Browser automation fatal error: " +
        (
            automationError &&
            automationError.message
                ? automationError.message
                : String(automationError)
        )
    );

    return {
        success: false,
        error:
            automationError &&
            automationError.message
                ? automationError.message
                : String(automationError),
        logs: diagnosticLogs
    };
}

};

const script = `(${browserSideAutomationTask.toString()})('${base64Payload}')`;

let result;

if (!this.page || this.page.isClosed()) {
    throw new Error(
        `[${this.browserType}] External browser page available nahi hai.`
    );
}

result = await this.page.evaluate(script);

console.log('\n================ AUTOMATION LOGS ===============');

if (result && result.logs) {
    result.logs.forEach(function(log) {
        console.log('  -> ' + log);
    });
}

console.log('================================================\n');


// =====================================================================
// FINAL RESULT
// =====================================================================

if (!result || !result.success) {

    throw new Error(
        `Automation stopped: ${result?.error || 'Unknown error'}`
    );
}

return {
    status: 200,
    success: true,
    totalFare: result.totalFare || backendRealFare,
    message: result.message
};
        }


    // ==========================================
    // 5. BOOKING PAYMENT INITIALIZATION (SKIPPED/HANDLED IN STEP 4)
    // ==========================================
    async bookingInitPayment(bookingData, clientTransactionId, totalAmount = null, bankId = 113) {
        this.sendProgress('Step 5', 'Payment gateway and QR code ready.', 100);
        await this.delay(1000);

        return {
            status: 200,
            success: true,
            message: 'Payment page and QR code successfully triggered.'
        };
    }

    // ==========================================
    // VERIFY PAYMENT
    // ==========================================
    async verifyPaymentAndGetPNR(clientTransactionId, totalAmount) {
        const cookies = await this.loadCookies();
        const txId = clientTransactionId;

        if (!txId) {
            throw new Error('Transaction ID missing hai.');
        }

        if (totalAmount === null || totalAmount === undefined || String(totalAmount).trim() === '') {
            throw new Error('Total amount missing hai.');
        }

        const url = `https://www.irctc.co.in/eticketing/protected/mapps1/bookTransaction/${txId}`;
        const headers = await this.getHeaders(
    cookies,
    'https://www.irctc.co.in/'
);

        const payload = {
            clientTransactionId: txId,
            totalFare: String(totalAmount)
        };

        const response = await this.safeFetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });

        this.validateResponse(response, 'Payment verification');
        const data = await this.parseResponse(response);

        if (data === null) {
            throw new Error('Payment verification response empty hai.');
        }

        return data;
    }

// ==========================================
// BOOK TICKET (EXTERNAL BROWSER / PUPPETEER)
// ==========================================
async bookTicket(bookingData) {

    console.log(
        '[API] bookTicket() called for External Browser.'
    );

    // ------------------------------------------
    // UNWRAP AUTOMATION DATA FIRST
    // ------------------------------------------
    if (
        bookingData &&
        bookingData.automationData
    ) {
        bookingData =
            bookingData.automationData;
    }

    // ------------------------------------------
    // BASIC VALIDATION
    // ------------------------------------------
    if (!bookingData || typeof bookingData !== 'object') {
        throw new Error(
            'Booking data invalid hai.'
        );
    }

    // ------------------------------------------
    // AUTO LOGIN CREDENTIALS
    // ------------------------------------------
    const credentials =
        bookingData.credentials || {};

    const username =
        String(
            credentials.username || ''
        ).trim();

    const password =
        String(
            credentials.password || ''
        );

    // ------------------------------------------
    // CREDENTIALS REQUIRED
    // ------------------------------------------
    if (!username) {
        throw new Error(
            'IRCTC username available nahi hai.'
        );
    }

    if (!password) {
        throw new Error(
            'IRCTC password available nahi hai.'
        );
    }

    // ------------------------------------------
    // PUPPETEER PAGE CHECK
    // ------------------------------------------
    if (!this.page || this.page.isClosed()) {
        throw new Error(
            `[${this.browserType}] Puppeteer page available nahi hai.`
        );
    }

    // ------------------------------------------
    // JOURNEY DATE
    // ------------------------------------------
    if (bookingData.date) {
        bookingData.journeyDate =
            String(
                bookingData.date
            ).replace(/-/g, '');
    }

   if (!bookingData.journeyDate) {
    throw new Error(
        'Journey date missing hai.'
    );
}

// ------------------------------------------
// AUTO LOGIN
// ------------------------------------------
await this.autoLogin(
    username,
    password
);

try {

        console.log(
            '[API] Starting complete booking sequence flow...'
        );

        this.sendProgress(
            'Initializing',
            'Starting secure ticket booking sequence...',
            10
        );

        const dynamicTxnId =
            this.generateTransactionId();

        bookingData.dynamicTxnId =
            dynamicTxnId;

            // STEP 1: Check Availability & Real Fare
           const quotaUpper = String(bookingData.quota || '').toUpperCase();
const isTatkalOrPremium = quotaUpper === 'TQ' || quotaUpper === 'TATKAL' || quotaUpper === 'PT' || quotaUpper === 'PREMIUM TATKAL';

if (!isTatkalOrPremium) {
    // Purana code yahan aayega [cite: 1]
    const availabilityResponse = await this.checkAvailabilityAndFare(bookingData);
    if (availabilityResponse) {
        let extractedRealFare = availabilityResponse.totalFare || 
                               (availabilityResponse.avlFareResponseDTO && availabilityResponse.avlFareResponseDTO[0]?.totalFare) ||
                               (availabilityResponse.lapFareDetails && availabilityResponse.lapFareDetails[0]?.totalFare);
        if (extractedRealFare) {
            bookingData.realFare = String(extractedRealFare);
        }
    }

    // STEP 2: Alternate Availability [cite: 1]
    await this.checkAlternateAvailability(bookingData);
} else {
    console.log('[TATKAL / PREMIUM TATKAL MODE] Skipping avlFarenquiry and altAvlEnq API calls to prevent 406/blocking.');
}

            // STEP 3: Master Passengers List
            const masterPassengerResponse = await this.getMasterPassengerList();
            if (masterPassengerResponse && Array.isArray(masterPassengerResponse) && masterPassengerResponse.length > 0) {
                bookingData.passengers = masterPassengerResponse.map(function(p) {
    return {
        name: p.passengerName || p.name,
        age: p.passengerAge || p.age,
        gender: p.passengerGender || p.gender,
        berth: p.passengerBerthChoice || p.berth || 'No Preference',
        masterPsgnId: p.masterPsgnId || '',
        mobile: bookingData.mobile || ''
    };
});
            } else if (!Array.isArray(bookingData.passengers) || bookingData.passengers.length === 0) {
                throw new Error('Master list empty hai aur form mein bhi koi passenger nahi mila.');
            }

            // STEP 4: Full Automated UI Flow
            
            const stepResult = await this.finalFareAndPassengerEnquiry(bookingData);
            if (!stepResult || !stepResult.success) {
                throw new Error('Automated booking flow failed.');
            }

            // IPAY QR FLOW
if (String(bookingData.payment || bookingData.paymentType || bookingData.paymentMethod || '')
    .trim().toUpperCase().startsWith('IPAY')) {

    console.log('[IPAY] Waiting for iPay QR page...');

    await new Promise(r => setTimeout(r, 2500));

    for (let i = 0; i < 30; i++) {
        try {
            const ready = await this.page.evaluate(() =>
                !!document.querySelector('#upiAccordionBtn')
            );

            if (ready) break;
        } catch (e) {}

        await new Promise(r => setTimeout(r, 300));
    }

    const upi = await this.page.$('#upiAccordionBtn');

if (upi) {
    await upi.click();
} else {
    throw new Error('iPay UPI button nahi mila.');
}

    await new Promise(r => setTimeout(r, 500));

    const qrPay = await this.page.$('label[for="qr-click"]');

if (qrPay) {
    await qrPay.click();
} else {
    throw new Error('iPay QR option nahi mila.');
}

    console.log('[IPAY] UPI selected + Click Here To Pay Using QR clicked.');


for (let i = 0; i < 30; i++) {
    const qrBtn = await this.page.$('#irctc-generate-qr-btn');

    if (qrBtn) {
        await qrBtn.click();
        console.log('[IPAY] Click here to show QR clicked.');
        break;
    }

    await new Promise(r => setTimeout(r, 200));
}

        }
await new Promise(function(r) {
    setTimeout(r, 2500);
});

console.log('[QR] Waiting for payment page to load...');
    
var paymentValue = String(
    bookingData.payment ||
    bookingData.paymentType ||
    bookingData.paymentMethod ||
    ''
).trim().toUpperCase();

var qrSelector = null;

if (paymentValue.startsWith('IPAY')) {
    qrSelector = '#irctcDynamicQrCanvas';
} else if (paymentValue.startsWith('PAYTM')) {
    qrSelector = 'img[data-key="qr-code"]';
} else if (paymentValue.startsWith('PHONEPE')) {
    qrSelector = 'img[src^="data:image/"]';
}

if (!qrSelector) {
    throw new Error(
        'QR selector payment ke liye available nahi hai: ' +
        paymentValue
    );
}

try {
    await this.page.waitForSelector(qrSelector, {
        visible: true,
        timeout: 15000
    });

    console.log(
        '[QR] ' + paymentValue + ' QR detected successfully.'
    );

} catch (e) {
    throw new Error(
        paymentValue + ' QR visible nahi hua: ' + e.message
    );
}

console.log(
    '[QR] ' +
    paymentValue +
    ' QR detected successfully.'
);

console.log('[API] Booking flow successfully completed.');

            return {
                success: true,
                supported: true,
                data: stepResult
            };

        } catch (error) {
            console.error('[API] Sequence execution failed:', error.message);
            this.sendProgress('Error', error.message, 0);
            throw error;
        }
    
    }
}

module.exports = APIEngine;