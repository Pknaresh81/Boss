// Safe diagnostics update: HTTP classification, JWT expiry inspection, browser health and /nget/error detection.
const axios = require('axios');
const fs = require('fs');
const path = require('path');
// Shared across APIEngine instances so two instances cannot submit the same
// booking concurrently in the same browser type.
const activeBookingLocks = new Set();
class APIEngine {
   constructor(
    pageOrCaptcha = null,
    winOrCell = null,
    requestCaptcha = null,
    browserType = 'WEB',
    qrCallbacks = null
) {
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
this.qrCallbacks =
    qrCallbacks || {};
    this.browserType = String(browserType || 'WEB')
        .trim()
        .toUpperCase();
        this.winId = '';
    // Har browser ki separate session file
    this.sessionFilePath = path.join(
        __dirname,
        `session_${this.browserType.toLowerCase()}.json`
    );
    console.log(
        `[APIEngine] Browser=${this.browserType} | Session=${this.sessionFilePath}`
    );
}
    // HELPER: SEND LIVE PROGRESS TO UI
    sendProgress(stepName, message, percentage = 0) {
        console.log(`[PROGRESS] ${stepName}: ${message} (${percentage}%)`);
        if (this.win && this.win.webContents) {
            try {
                this.win.webContents.send('booking-progress', {
                    winId: this.winId,
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
// HELPER: LIVE BOOKING STATUS
// Browser-side diagnostic log ko UI progress mein convert karta hai
sendBookingStatus(message, stepName = 'BOOKING', percentage = 0) {
    console.log(
        `[BOOKING STATUS] ${message} (${percentage}%)`
    );
    this.sendProgress(
        stepName,
        message,
        percentage
    );
}
// HELPER: UPDATE MINI WINDOW AVAILABILITY/FARE
sendAvailabilityFare(availability, fare) {
    console.log(
    '[MINI WINDOW] Sending Availability/Fare sent.'
);
    if (
        !this.win ||
        this.win.isDestroyed()
    ) {
        console.warn(
            '[MINI WINDOW] Cannot update Availability/Fare. Window unavailable.'
        );
        return;
    }
    const cleanFare = fare && fare !== '--'
        ? String(fare).replace(/₹|Rs\.?|,/gi, '').trim() || '--'
        : '--';
    try {
        this.win.webContents.send(
            'mini-window-data-update',
            {
                winId: this.winId,
                availability:
                    availability || '--',
                fare:
                    cleanFare
            }
        );
    } catch (error) {
        console.warn(
            '[MINI WINDOW] Availability/Fare update failed:',
            error.message
        );
    }
}
// HELPER: CONTROLLED DELAY (MS)
delay(ms) {
    const delayMs = Number(ms);
    if (!Number.isFinite(delayMs) || delayMs < 0) {
        return Promise.resolve();
    }
    return new Promise(resolve => {
        setTimeout(resolve, delayMs);
    });
}
// HELPER: RETRY BACKOFF
getRetryDelay(attempt, baseDelay = 1000, maxDelay = 5000) {
    const safeAttempt = Math.max(1, Number(attempt) || 1);
    const delayMs = Math.min(
        maxDelay,
        baseDelay * Math.pow(2, safeAttempt - 1)
    );
    return delayMs;
}
// HELPER: DETECT HIGH LOAD / RETRY PAGE
async detectRetryPageStatus() {
    if (!this.page || this.page.isClosed()) {
        return null;
    }
    try {
        const pageStatus = await this.page.evaluate(() => {
            const bodyText =
                document.body
                    ? document.body.innerText || ''
                    : '';
            const text = bodyText
                .replace(/\s+/g, ' ')
                .trim();
            const lowerText = text.toLowerCase();
            const highLoad =
                lowerText.includes('high load');
            const unableProcess =
                lowerText.includes('unable to process request') ||
                lowerText.includes('unable to process the request');
            const currentUrl = String(location.href || '').toLowerCase();
            const ngetError = currentUrl.includes('/nget/error') ||
                lowerText.includes('something went wrong') ||
                lowerText.includes('error occurred while processing');
            const loginRequired = currentUrl.includes('/nget/user-profile') === false &&
                (lowerText.includes('session expired') ||
                 lowerText.includes('please login') ||
                 lowerText.includes('please log in') ||
                 lowerText.includes('login to continue'));
            if (ngetError) {
                return { type: 'NGET_ERROR', message: text, url: currentUrl };
            }
            if (loginRequired) {
                return { type: 'LOGIN_OR_SESSION_REQUIRED', message: text, url: currentUrl };
            }
            if (highLoad) {
                return {
                    type: 'HIGH LOAD',
                    message: text
                };
            }
            if (unableProcess) {
                return {
                    type: 'UNABLE TO PROCESS REQUEST',
                    message: text
                };
            }
            return null;
        });
        if (pageStatus) {
            // Actual error ke mutabik alag status bhejo.
            const errorStep = pageStatus.type;
            const errorMessage = pageStatus.type === 'HIGH LOAD'
                ? 'IRCTC page reports high load.'
                : pageStatus.type === 'NGET_ERROR'
                    ? 'IRCTC /nget/error page detected. Check the page message.'
                    : pageStatus.type === 'LOGIN_OR_SESSION_REQUIRED'
                        ? 'Login/session may have expired. Verify login in the browser.'
                        : 'IRCTC page reports unable to process request.';
            this.sendDiagnostic(pageStatus.type, errorMessage, { url: pageStatus.url || null, pageMessage: pageStatus.message });
            this.sendProgress(
                errorStep,
                errorMessage,
                20
            );
            console.warn(
                `[RETRY PAGE ${this.browserType}] ${errorStep}:`,
                pageStatus.message
            );
            return pageStatus;
        }
    } catch (error) {
        console.warn(
            `[RETRY PAGE ${this.browserType}] Page status detection failed:`,
            error.message
        );
    }
    return null;
}
// HELPER: HUMAN-LIKE TYPE IN INPUT FIELD
async typeHumanLike(selector, text, minDelay = 20, maxDelay = 60) {
    if (!this.page || !selector || !text) return;
    await this.page.focus(selector);
    const textStr = String(text);
    for (let i = 0; i < textStr.length; i++) {
        await this.page.type(selector, textStr[i]);
        // Random micro-delay between letters (20ms to 60ms)
        const delay = Math.floor(Math.random() * (maxDelay - minDelay)) + minDelay;
        await this.delay(delay);
    }
}
    // SAFE DIAGNOSTICS: HTTP / SESSION / BROWSER STATUS
    classifyHttpStatus(status) {
        const code = Number(status) || 0;
        if (code === 0) return { code, category: 'NETWORK_ERROR', message: 'Browser/network request failed; check connection and browser page.' };
        if (code === 401) return { code, category: 'AUTH_REQUIRED', message: 'HTTP 401: login/session may have expired. Please verify login in the browser.' };
        if (code === 403) return { code, category: 'ACCESS_FORBIDDEN', message: 'HTTP 403: server denied this request. Do not retry automatically; check the page and account status.' };
        if (code === 429) return { code, category: 'RATE_LIMITED', message: 'HTTP 429: too many requests. Stop and wait before trying again.' };
        if (code === 510) return { code, category: 'SERVER_OR_POLICY_ERROR', message: 'HTTP 510: server returned an additional-policy/processing error. Check the IRCTC page for its explanation.' };
        if (code >= 500) return { code, category: 'SERVER_ERROR', message: `HTTP ${code}: server-side error.` };
        if (code >= 400) return { code, category: 'CLIENT_ERROR', message: `HTTP ${code}: request was rejected.` };
        return { code, category: 'OK', message: 'Request completed.' };
    }
    sendDiagnostic(category, message, details = {}) {
        const entry = {
            browserType: this.browserType,
            category: String(category || 'INFO'),
            message: String(message || ''),
            details: details && typeof details === 'object' ? details : {},
            timestamp: new Date().toISOString()
        };
        console.log(`[DIAGNOSTIC ${this.browserType}] ${entry.category}: ${entry.message}`, entry.details);
        if (this.win && !this.win.isDestroyed?.()) {
            try { this.win.webContents.send('booking-diagnostic', entry); }
            catch (err) { console.warn('[DIAGNOSTIC] UI send failed:', err.message); }
        }
        return entry;
    }
    inspectJwtExpiry(token) {
        const value = String(token || '').replace(/^Bearer\s+/i, '').trim();
        if (!value) return { present: false, validFormat: false, expired: null, expiresAt: null, reason: 'JWT missing' };
        const parts = value.split('.');
        if (parts.length !== 3) return { present: true, validFormat: false, expired: null, expiresAt: null, reason: 'Token is not a standard three-part JWT' };
        try {
            const payloadText = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
            const payload = JSON.parse(payloadText);
            if (!payload.exp) return { present: true, validFormat: true, expired: null, expiresAt: null, reason: 'JWT has no exp claim; expiry cannot be verified' };
            const expiresAt = Number(payload.exp) * 1000;
            const expired = !Number.isFinite(expiresAt) || expiresAt <= Date.now();
            return { present: true, validFormat: true, expired, expiresAt: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null, reason: expired ? 'JWT expired' : 'JWT not expired' };
        } catch (err) {
            return { present: true, validFormat: false, expired: null, expiresAt: null, reason: 'JWT payload could not be decoded' };
        }
    }
    async getBrowserHealth() {
        if (!this.page || this.page.isClosed()) {
            return { connected: false, browserType: this.browserType, url: null, title: null, reason: 'Browser page is closed or unavailable' };
        }
        try {
            const state = await this.page.evaluate(() => ({ url: location.href, title: document.title || '' }));
            return { connected: true, browserType: this.browserType, ...state, reason: 'Browser page is responsive' };
        } catch (err) {
            return { connected: false, browserType: this.browserType, url: null, title: null, reason: err.message };
        }
    }
    // SAFE FETCH (EXISTING REQUEST FLOW PRESERVED)
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
        this.sendDiagnostic('BROWSER_DISCONNECTED', 'Browser page is closed or unavailable.', { url, method });
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
    // Browser fetch owns browser-controlled headers and the cookie jar.
    // Never try to inject Cookie/Connection/Sec-Fetch headers from page JS.
    const finalHeaders = {};
    for (const [headerName, headerValue] of Object.entries(customHeaders)) {
        const normalizedName = String(headerName).toLowerCase();
        if (
            normalizedName === 'cookie' ||
            normalizedName === 'connection' ||
            normalizedName.startsWith('sec-fetch-') ||
            normalizedName === 'host' ||
            normalizedName === 'origin' ||
            normalizedName === 'referer' ||
            normalizedName === 'content-length'
        ) {
            continue;
        }
        if (headerValue !== undefined && headerValue !== null) {
            finalHeaders[headerName] = String(headerValue);
        }
    }
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
        const statusInfo = this.classifyHttpStatus(result.status);
        if (statusInfo.category !== 'OK') {
            this.sendDiagnostic(statusInfo.category, statusInfo.message, {
                url, method, status: statusInfo.code, statusText: result.statusText || '',
                error: result.error || null
            });
        }
        return {
            status:
                result.status || 0,
            statusText:
                result.statusText || '',
            diagnostic: statusInfo,
            error: result.error || null,
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
    // TRANSACTION ID GENERATOR
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
    // SESSION SAVE
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

// PRE-LOGIN AVAILABILITY & FARE CHECK (NO TOKEN = NO 409, WORKS ON WEB/WEB2/WEB3/WEB4)
async checkPreLoginAvailabilityFromUI(bookingData) {
    if (!this.page || this.page.isClosed()) return;

    const isFirefoxWEB4 = String(this.browserType).toUpperCase() === 'WEB4';
    const targetUrl = isFirefoxWEB4
        ? 'https://www.irctc.co.in/eticket/train-search'
        : 'https://www.irctc.co.in/nget/train-search';

    try {
        this.sendBookingStatus('Availability aur Fare check kar rahe hain...', 'PRE-LOGIN AVAILABILITY', 5);

        if (!this.page.url().includes(new URL(targetUrl).pathname)) {
            await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        }

        const jDate = String(bookingData.journeyDate || bookingData.date || '').replace(/-/g, '');
        const fromStn = String(bookingData.fromStation || '').trim().toUpperCase();
        const toStn = String(bookingData.toStation || '').trim().toUpperCase();
        const classTp = String(bookingData.trainClass || bookingData.classType || 'SL').trim().toUpperCase();
        const trainNo = String(bookingData.trainNo || '').trim();
        const quotaRaw = String(bookingData.quota || 'GN').trim().toUpperCase();
        const quotaMap = { GENERAL: 'GN', TATKAL: 'TQ', 'PREMIUM TATKAL': 'PT' };
        const quotaCd = quotaMap[quotaRaw] || quotaRaw;

        if (!/^\d{8}$/.test(jDate) || !fromStn || !toStn || !trainNo) return;

        // Public pre-login enquiry (No Bearer token attached, so zero HTTP 409 conflict)
        const result = await this.page.evaluate(async (d) => {
            try {
                const url = `https://www.irctc.co.in/eticketing/protected/mapps1/avlFarenquiry/${encodeURIComponent(d.trainNo)}/${encodeURIComponent(d.jDate)}/${encodeURIComponent(d.fromStn)}/${encodeURIComponent(d.toStn)}/${encodeURIComponent(d.classTp)}/${encodeURIComponent(d.quotaCd)}/N`;
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Content-Type': 'application/json; charset=UTF-8',
                        'Client-Device-Id': 'WEB',
                        'Greq': String(Date.now())
                    },
                    body: JSON.stringify({
                        classCode: d.classTp,
                        concessionBooking: false,
                        fromStnCode: d.fromStn,
                        ftBooking: false,
                        isLogedinReq: false,
                        journeyDate: d.jDate,
                        loyaltyRedemptionBooking: false,
                        moreThanOneDay: true,
                        paymentFlag: 'N',
                        quotaCode: d.quotaCd,
                        returnJourney: false,
                        ticketType: 'E',
                        toStnCode: d.toStn,
                        trainNumber: d.trainNo
                    })
                });
                const text = await res.text();
                return { status: res.status, body: text };
            } catch (e) {
                return { status: 0, error: e.message };
            }
        }, { trainNo, jDate, fromStn, toStn, classTp, quotaCd });

        console.log('[PRE-LOGIN AVL] HTTP Status:', result?.status);

        if (result && result.status === 200 && result.body && !result.body.trim().startsWith('<')) {
            const parsed = JSON.parse(result.body);
            const totalFare = parsed.totalFare || parsed.baseFare || '';
            const avlList = Array.isArray(parsed.avlDayList) ? parsed.avlDayList : [];
            const statusText = avlList[0]?.availablityStatus || parsed.availablityStatus || 'CHECKED';

            if (totalFare) {
                bookingData.realFare = String(totalFare);
            }
            this.sendAvailabilityFare(statusText, totalFare ? `₹${totalFare}` : '--');
            console.log(`[PRE-LOGIN AVL SUCCESS] ${statusText} | Fare: ₹${totalFare}`);
        }
    } catch (err) {
        console.warn('[PRE-LOGIN AVL] Failed:', err.message);
    }
}

// IRCTC AUTO LOGIN
// RESPONSIVE LOGIN - SMALL / LARGE SCREEN
async autoLogin(username, password) {
    const isFirefoxWEB4 =
        String(this.browserType).toUpperCase() === 'WEB4';
    if (!this.page || this.page.isClosed()) {
        throw new Error(
            `[${this.browserType}] Browser page available nahi hai.`
        );
    }
    console.log(
        `[AUTO LOGIN ${this.browserType}] Opening IRCTC page...`
    );
const currentUrl = this.page.url();
const targetLoginUrl =
    String(this.browserType).toUpperCase() === 'WEB4'
        ? 'https://www.irctc.co.in/eticket/train-search'
        : 'https://www.irctc.co.in/nget/train-search';
if (!currentUrl.includes(new URL(targetLoginUrl).pathname)) {
    await this.page.goto(targetLoginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 120000
    });
} else {
    console.log(
        `[AUTO LOGIN ${this.browserType}] Train-search page already open. Skipping reload.`
    );
}
    console.log(
        `[AUTO LOGIN ${this.browserType}] IRCTC page loaded.`
    );
// BOSS - PERMANENT POPUP MONITOR
// WEB / WEB2 / WEB3 = ENGLISH POPUP
// WEB4 = VIGILANCE POPUP
// MAIN FRAME + ALL IFRAMES
// Previous monitor cleanup (if autoLogin runs again)
if (this.__bossPopupMonitorCleanup) {
    this.__bossPopupMonitorCleanup();
}
const monitorPage = this.page;
const monitorIsWEB4 = isFirefoxWEB4;
// Install popup detector inside any frame
const installPopupWatcherInFrame = async (frame) => {
    try {
        await frame.evaluate((isWEB4) => {
            if (window.__bossUnifiedPopupWatcherInstalled) {
                return;
            }
            window.__bossUnifiedPopupWatcherInstalled = true;
            const isVisible = (el) => {
                if (!el || !el.isConnected || el.disabled) return false;
                const style = window.getComputedStyle(el);
                return (
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    el.getClientRects().length > 0
                );
            };
            const detectAndClosePopups = () => {
                try {
                    // WEB / WEB2 / WEB3 - ENGLISH POPUP
                    if (!isWEB4) {
                        const buttons = Array.from(
                            document.querySelectorAll('button')
                        );
                        const englishButton = buttons.find(button => {
                            return (
                                button.textContent
                                    .replace(/\s+/g, ' ')
                                    .trim()
                                    .toLowerCase() === 'english' &&
                                isVisible(button) &&
                                button.dataset.bossEnglishClicked !== '1'
                            );
                        });
                        if (englishButton) {
                            englishButton.dataset.bossEnglishClicked = '1';
                            console.log(
                                '[BOSS] English popup detected. Clicking English.'
                            );
                            englishButton.click();
                        }
                    }
                    // WEB4 - VIGILANCE / AWARENESS POPUP
                    if (isWEB4) {
                        const selectors = [
                            'button.vigilance-banner-close',
                            'button[aria-label*="dismiss" i]',
                            'button[aria-label*="close" i]',
                            'button[title*="close" i]',
                            'button[title*="dismiss" i]',
                            'button[class*="close" i]',
                            '[data-testid*="close" i]'
                        ];
                        const elements = new Set();
                        selectors.forEach(selector => {
                            document.querySelectorAll(selector).forEach(el => {
                                elements.add(el);
                            });
                        });
                        elements.forEach(el => {
                            if (!isVisible(el)) return;
                            const label = [
                                el.innerText,
                                el.getAttribute('aria-label'),
                                el.getAttribute('title'),
                                el.className
                            ].join(' ').toLowerCase();
                            let parent = el;
                            let context = '';
                            for (let i = 0; i < 6 && parent; i++) {
                                context += ' ' + (parent.innerText || '');
                                parent = parent.parentElement;
                            }
                            context = context.toLowerCase();
                            const knownButton =
                                el.matches('button.vigilance-banner-close');
                            const vigilanceButton =
                                /close|dismiss|×/.test(label) &&
                                /vigilance|awareness/.test(context);
                            if (
                                (knownButton || vigilanceButton) &&
                                el.dataset.bossVigilanceClicked !== '1'
                            ) {
                                el.dataset.bossVigilanceClicked = '1';
                                console.log(
                                    '[BOSS] Vigilance popup detected. Closing.'
                                );
                                el.click();
                            }
                        });
                    }
                } catch (error) {
                    console.warn(
                        '[BOSS] Popup detection error:',
                        error.message
                    );
                }
            };
            // Immediate check
            detectAndClosePopups();
            // Detect dynamically added popup elements
            const observer = new MutationObserver(() => {
                detectAndClosePopups();
            });
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true
            });
            // Continuous backup check
            setInterval(detectAndClosePopups, 500);
            console.log(
                '[BOSS] Popup watcher installed in frame:',
                location.href
            );
        }, monitorIsWEB4);
    } catch (error) {
        // Frame may be navigating or detached; next scan will retry
    }
};
// Install in all currently existing frames
const scanAllFrames = async () => {
    if (monitorPage.isClosed()) return;
    const frames = monitorPage.frames();
    for (const frame of frames) {
        await installPopupWatcherInFrame(frame);
    }
};
// Install when a new frame appears or navigates
const handleFrameChange = (frame) => {
    installPopupWatcherInFrame(frame);
};
monitorPage.on('frameattached', handleFrameChange);
monitorPage.on('framenavigated', handleFrameChange);
// Initial installation
await scanAllFrames();
// Backup: continuously scan all frames
const popupMonitorTimer = setInterval(() => {
    scanAllFrames();
}, 1000);
// Cleanup if autoLogin is started again
this.__bossPopupMonitorCleanup = () => {
    clearInterval(popupMonitorTimer);
    monitorPage.off('frameattached', handleFrameChange);
    monitorPage.off('framenavigated', handleFrameChange);
};
console.log(
    `[BOSS ${this.browserType}] Permanent all-frame popup monitor active.`
);


// BOSS SESSION GUARD - STRICT IRCTC SESSION CHECK
const existingSession = await this.page.evaluate(() => {
    const visible = (el) => {
        if (!el || !el.isConnected) return false;

        const style = window.getComputedStyle(el);

        return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            el.getClientRects().length > 0
        );
    };

    // Login form visible hai to session active nahi hai
    const loginForm = Array.from(
        document.querySelectorAll(
            'input[formcontrolname="userid"], input[formcontrolname="password"]'
        )
    ).some(visible);

    if (loginForm) return false;

    // Sirf actual Logout control ko authenticated session ka proof maanein
    const logoutControl = Array.from(
        document.querySelectorAll(
            'a[href*="logout" i], button[class*="logout" i], a[aria-label*="logout" i], button[aria-label*="logout" i]'
        )
    ).some(visible);

    return logoutControl;
});

if (existingSession) {
    console.log(
        `[AUTO LOGIN ${this.browserType}] Verified IRCTC session active.`
    );

    this.sendBookingStatus(
        'Verified IRCTC session already active.',
        'LOGIN SESSION ACTIVE',
        15
    );

    return true;
}

console.log(
    `[AUTO LOGIN ${this.browserType}] No verified session. Starting fresh login process.`
);


   // WEB4: Skip unnecessary fixed page wait
// Other browsers remain unchanged
if (!isFirefoxWEB4) {
    await new Promise(resolve =>
        setTimeout(resolve, 500)
    );
}
        // STEP 1 - WAIT FOR LOGIN BUTTON
        // ALL BROWSERS: WEB / WEB2 / WEB3 / WEB4
        // NO FIXED TIMEOUT
        const loginFormAlreadyOpen =
            await this.page.$('input[formcontrolname="userid"]');
        if (!loginFormAlreadyOpen) {
            console.log(
                `[AUTO LOGIN ${this.browserType}] Waiting for LOGIN button...`
            );
            try {
                if (!isFirefoxWEB4) {
                    const menuButton = await this.page.$(
                        'i.fa.fa-align-justify'
                    );
                    if (menuButton) {
                        await this.page.evaluate(() => {
                            const icon = document.querySelector(
                                'i.fa.fa-align-justify'
                            );
                            if (icon) {
                                const clickable =
                                    icon.closest('button, a, div') || icon;
                                clickable.click();
                            }
                        });
                        console.log(
                            `[AUTO LOGIN ${this.browserType}] Menu opened.`
                        );
                    }
                }
               // LOGIN BUTTON DIKHNE TAK WAIT KARO
                const loginButtonHandle = await this.page.waitForFunction(
                    (isWeb4) => {
                        // 1. Jab tak page poora load na ho, tab tak wait karo
                        if (document.readyState !== 'complete') return false;

                        const selector = isWeb4
                            ? 'button.btn-login'
                            : 'button.search_btn';
                        const buttons = Array.from(
                            document.querySelectorAll(selector)
                        );
                        return buttons.find(button => {
                            const text = (
                                button.innerText ||
                                button.textContent ||
                                ''
                            ).trim().toUpperCase();
                            const style = window.getComputedStyle(button);
                            
                            // 2. Strict visibility check: display, visibility, opacity aur actual screen size
                            const visible =
                                style.display !== 'none' &&
                                style.visibility !== 'hidden' &&
                                Number(style.opacity) !== 0 &&
                                button.getClientRects().length > 0;
                            
                            const enabled =
                                !button.disabled &&
                                button.getAttribute('aria-disabled') !== 'true';
                            
                            const correctText = isWeb4
                                ? text === 'LOGIN'
                                : true;

                            return visible && enabled && correctText;
                        }) || false;
                    },
                    {
                        polling: 100,
                        timeout: 0
                    },
                    isFirefoxWEB4
                );
                const loginButton = loginButtonHandle.asElement();
                if (!loginButton) {
                    throw new Error('LOGIN button element nahi mila.');
                }
                // BUTTON DIKHTE HI TURANT CLICK
                await loginButton.click();
                console.log(
                    `[AUTO LOGIN ${this.browserType}] LOGIN button clicked successfully.`
                );
            } catch (loginButtonError) {
                console.error(
                    `[AUTO LOGIN ${this.browserType}] LOGIN button error:`,
                    loginButtonError.message
                );
                throw loginButtonError;
            }
            // LOGIN FORM DIKHNE TAK WAIT
            await this.page.waitForSelector(
                'input[formcontrolname="userid"]',
                {
                    visible: true,
                    timeout: 0
                }
            );
            console.log(
                `[AUTO LOGIN ${this.browserType}] Login window opened successfully.`
            );
        }
        this.sendBookingStatus(
            'IRCTC par login ho rahe hai...',
            'IRCTC LOGIN',
            10
        );
// CLEAR OLD LOGIN CREDENTIALS
// THEN FILL SELECTED USERNAME + PASSWORD
const usernameSelector =
    'input[formcontrolname="userid"]';
const passwordSelector =
    'input[formcontrolname="password"]';
// USERNAME
await this.page.waitForSelector(
    usernameSelector,
    {
        visible: true,
        timeout: 15000
    }
);
const usernameInput =
    await this.page.$(usernameSelector);
if (!usernameInput) {
    throw new Error(
        `[${this.browserType}] Username field nahi mila.`
    );
}
// OLD USERNAME CLEAR
await usernameInput.click();
await this.page.evaluate(
    (selector) => {
        const input =
            document.querySelector(selector);
        if (!input) return;
        input.focus();
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
        input.blur();
    },
    usernameSelector
);


// USERNAME - Complete value at once
await this.page.evaluate(
    (args) => {
        const input = document.querySelector(args.selector);
        if (!input) throw new Error('Username field nahi mila.');

        const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value'
        ).set;

        input.click();
        input.focus();

        setter.call(input, '');

        input.dispatchEvent(
            new Event('input', { bubbles: true })
        );

        const usernameText = String(args.value || '').trim();

        setter.call(input, usernameText);

        input.dispatchEvent(
            new Event('input', { bubbles: true })
        );

        input.dispatchEvent(
            new Event('change', { bubbles: true })
        );
    },
    {
        selector: usernameSelector,
        value: String(username || '')
    }
);

await this.delay(600);

console.log(`[AUTO LOGIN ${this.browserType}] Username filled.`);

// PASSWORD
await this.page.waitForSelector(
    passwordSelector,
    {
        visible: true,
        timeout: 15000
    }
);
const passwordInput =
    await this.page.$(passwordSelector);
if (!passwordInput) {
    throw new Error(
        `[${this.browserType}] Password field nahi mila.`
    );
}
// OLD PASSWORD CLEAR
await passwordInput.click();
await this.page.evaluate(
    (selector) => {
        const input =
            document.querySelector(selector);
        if (!input) return;
        input.focus();
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
        input.blur();
    },
    passwordSelector
);


// PASSWORD - Complete value at once
await this.page.evaluate(
    (args) => {
        const input = document.querySelector(args.selector);
        if (!input) throw new Error('Password field nahi mila.');

        const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value'
        ).set;

        input.click();
        input.focus();

        setter.call(input, '');

        input.dispatchEvent(
            new Event('input', { bubbles: true })
        );

        const passwordText = String(args.value || '');

        setter.call(input, passwordText);

        input.dispatchEvent(
            new Event('input', { bubbles: true })
        );

        input.dispatchEvent(
            new Event('change', { bubbles: true })
        );
    },
    {
        selector: passwordSelector,
        value: String(password || '')
    }
);

await this.delay(600);

console.log(`[AUTO LOGIN ${this.browserType}] Password filled.`);

    // CAPTCHA / SIGN IN MANUAL
    console.log(
    `[AUTO LOGIN ${this.browserType}] Username/password filled.`
);
 // CLICK SIGN IN
const signInSelector = isFirefoxWEB4
    ? 'button.button-primary.active[type="submit"]'
    : 'button.search_btn.train_Search.train_Search_custom_hover';
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
    const button = await this.page.$(signInSelector);
    if (!button) {
        throw new Error('SIGN IN button not found.');
    }
    await button.evaluate((el) => {
        el.scrollIntoView({
            block: 'center',
            inline: 'center'
        });
    });
    await new Promise(resolve => setTimeout(resolve, 500));
    const isDisabled = await button.evaluate(
        el => el.disabled ||
            el.getAttribute('aria-disabled') === 'true'
    );
    if (isDisabled) {
        throw new Error('SIGN IN button is disabled.');
    }
    await button.click();
    console.log(
        `[AUTO LOGIN ${this.browserType}] SIGN IN click sent.`
    );

// WAIT FOR IRCTC LOGIN TO COMPLETE
// WEB / WEB2 / WEB3 / WEB4 - same login confirmation logic

console.log(
    `[AUTO LOGIN ${this.browserType}] Waiting for login form to close and loading to finish...`
);

try {

    await this.page.waitForFunction(() => {

        const isVisible = (el) => {
            if (!el || !el.isConnected) return false;

            const style = window.getComputedStyle(el);

            return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                Number(style.opacity) !== 0 &&
                el.getClientRects().length > 0
            );
        };

        // Login form abhi visible hai?
        const loginFormVisible = Array.from(
            document.querySelectorAll(
                'input[formcontrolname="userid"], input[formcontrolname="password"]'
            )
        ).some(isVisible);

        // Page loading indicators
        const loadingSelectors = [
            '.loading',
            '.loader',
            '.spinner',
            '.fa-spinner',
            '.ngx-spinner-overlay',
            '.ngx-spinner',
            '.pi-spinner',
            'mat-progress-spinner',
            'mat-spinner',
            '[role="progressbar"]',
            '[aria-busy="true"]'
        ];

        let loadingVisible = false;

        for (const selector of loadingSelectors) {
            const elements = document.querySelectorAll(selector);

            if (Array.from(elements).some(isVisible)) {
                loadingVisible = true;
                break;
            }
        }

        // Login form ya loading abhi chal rahi hai
        if (loginFormVisible || loadingVisible) {
            window.__bossLoginReadySince = null;
            return false;
        }

        // 1.5 seconds tak confirm karo ki loading wapas nahi aayi
        if (!window.__bossLoginReadySince) {
            window.__bossLoginReadySince = Date.now();
            return false;
        }

        return Date.now() - window.__bossLoginReadySince >= 1500;

    }, {
        timeout: 120000,
        polling: 300
    });

    console.log(
        `[AUTO LOGIN ${this.browserType}] Login form closed and loading finished.`
    );

    this.sendBookingStatus(
        'IRCTC login successful.',
        'LOGIN SUCCESS',
        15
    );

} catch (loginWaitError) {

    throw new Error(
        `[${this.browserType}] Login confirmation failed: ${loginWaitError.message}`
    );

}

} catch (signInError) {
    console.error(
        `[AUTO LOGIN ${this.browserType}] SIGN IN click failed:`,
        signInError.message
    );
    throw new Error(
        `[${this.browserType}] ${signInError.message}`
    );
}
}
    // LOAD SESSION
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
    // LOAD COOKIES
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


// SAFE AUTO SESSION RESTORE
async autoRestoreSession() {
    if (!this.page || this.page.isClosed()) {
        console.warn(`[SESSION ${this.browserType}] Browser page unavailable.`);
        return false;
    }

    try {
        // 1. Browser mein current IRCTC cookies check karo
        const currentCookies = await this.page.cookies(
            'https://www.irctc.co.in'
        );

        // Existing browser cookies ko saved cookies se overwrite mat karo
        if (currentCookies && currentCookies.length > 0) {
            console.log(
                `[SESSION ${this.browserType}] Existing browser cookies found. Restore skipped.`
            );
            return false;
        }

        // 2. Browser-specific saved session read karo
        let savedData;

        try {
            savedData = this.loadSession();
        } catch (error) {
            console.warn(
                `[SESSION ${this.browserType}] Saved session unavailable:`,
                error.message
            );
            return false;
        }

        if (
            !savedData ||
            typeof savedData.cookies !== 'string' ||
            !savedData.cookies.trim()
        ) {
            console.warn(
                `[SESSION ${this.browserType}] Saved cookies not found.`
            );
            return false;
        }

        // 3. Cookie name=value pairs safely parse karo.
        // Cookie value mein "=" ho to bhi value truncate nahi hogi.
        const cookieObjects = savedData.cookies
            .split(';')
            .map(item => item.trim())
            .filter(Boolean)
            .map(cookieString => {
                const separatorIndex = cookieString.indexOf('=');

                if (separatorIndex <= 0) return null;

                const name = cookieString
                    .slice(0, separatorIndex)
                    .trim();

                const value = cookieString
                    .slice(separatorIndex + 1)
                    .trim();

                if (!name) return null;

                return {
                    name,
                    value,
                    url: 'https://www.irctc.co.in'
                };
            })
            .filter(Boolean);

        if (cookieObjects.length === 0) {
            console.warn(
                `[SESSION ${this.browserType}] Saved cookie format is invalid.`
            );
            return false;
        }

        this.sendBookingStatus(
            'Restoring saved browser cookies...',
            'SESSION RESTORE',
            10
        );

        // 4. Cookies browser mein set karo
        await this.page.setCookie(...cookieObjects);

        // 5. Cookies install hui hain ya nahi, verify karo
        const restoredCookies = await this.page.cookies(
            'https://www.irctc.co.in'
        );

        if (!restoredCookies || restoredCookies.length === 0) {
            console.warn(
                `[SESSION ${this.browserType}] Browser did not accept restored cookies.`
            );
            return false;
        }

        // 6. Agar current page IRCTC ka hai to reload karo.
        // About:blank ya kisi doosre page ko reload nahi karna.
        let currentUrl = '';

        try {
            currentUrl = this.page.url();
        } catch (e) {}

        if (currentUrl.startsWith('https://www.irctc.co.in/')) {
            await this.page.reload({
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
        }

        console.log(
            `[SESSION ${this.browserType}] ${restoredCookies.length} cookies restored.`
        );

        this.sendBookingStatus(
            'Saved cookies loaded. Checking IRCTC login...',
            'SESSION RESTORE',
            15
        );

        // Sirf cookies restore hui hain.
        // Actual login validity autoLogin() ke existing flow se check hogi.
        return true;

    } catch (error) {
        console.warn(
            `[SESSION ${this.browserType}] Session restore failed:`,
            error.message
        );

        this.sendBookingStatus(
            'Saved session could not be restored. Continuing to login check...',
            'SESSION RESTORE',
            10
        );

        return false;
    }
}


    // AUTO-UPDATE COOKIES FROM RESPONSE
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
    // CAPTCHA
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
    // CAPTCHA ERROR DETECTION
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
    // CAPTCHA SOURCE
    getCaptchaSource(data) {
        if (!data || typeof data !== 'object') {
            return null;
        }
        return data.captchaUrl || data.captchaImage || data.captcha || null;
    }
    // HELPER: EXTRACT CLEAN JWT TOKEN
    async getBrowserJwtToken() {
        // Pehle network se capture hua asli token check karein
        if (this.irctcAccessToken && String(this.irctcAccessToken).trim()) {
            const capturedToken = String(this.irctcAccessToken)
                .replace(/^Bearer\s+/i, '')
                .replace(/["\\\r\n]/g, '')
                .trim();
            const capturedStatus = this.inspectJwtExpiry(capturedToken);
            if (capturedStatus.expired === true) {
                this.sendDiagnostic(
                    'JWT_EXPIRED',
                    'Captured IRCTC access token has expired; checking the current browser session token.',
                    capturedStatus
                );
                this.irctcAccessToken = '';
            } else {
                return capturedToken;
            }
        }
        if (!this.page || this.page.isClosed()) return '';
        try {
            const rawToken = await this.page.evaluate(() => {
                const directKeys = ['jwt', 'jwtToken', 'token', 'access_token'];
                for (const k of directKeys) {
                    const v = localStorage.getItem(k) || sessionStorage.getItem(k);
                    if (v && v.includes('eyJ')) return v;
                }
                for (let i = 0; i < localStorage.length; i++) {
                    const val = localStorage.getItem(localStorage.key(i));
                    if (!val) continue;
                    if (val.startsWith('{') && val.includes('eyJ')) {
                        try {
                            const parsed = JSON.parse(val);
                            return parsed.jwt || parsed.token || parsed.access_token || '';
                        } catch (e) {}
                    }
                    if (val.includes('eyJ') && val.split('.').length === 3) return val;
                }
                return '';
            });
            const cleanToken = rawToken
                ? String(rawToken).replace(/^Bearer\s+/i, '').replace(/["\\\r\n]/g, '').trim()
                : '';
            if (!cleanToken) return '';
            const tokenStatus = this.inspectJwtExpiry(cleanToken);
            if (tokenStatus.expired === true) {
                this.sendDiagnostic(
                    'JWT_EXPIRED',
                    'Browser storage contains an expired IRCTC JWT; please log in again.',
                    tokenStatus
                );
                return '';
            }
            return cleanToken;
        } catch (e) {
            return '';
        }
    }
    // COMMON HEADERS
    async getHeaders(cookies, referer) {
    let jwtToken = await this.getBrowserJwtToken();
    const jwtStatus = this.inspectJwtExpiry(jwtToken);
    if (!jwtStatus.present) {
        this.sendDiagnostic('JWT_MISSING', 'No browser JWT was found. Login/session may be unavailable.', jwtStatus);
    } else if (jwtStatus.expired === true) {
        this.sendDiagnostic('JWT_EXPIRED', 'Browser JWT appears expired. Please log in again in the browser.', jwtStatus);
        // Do not attach a token that is already expired.
        jwtToken = '';
    } else if (jwtStatus.expired === null) {
        this.sendDiagnostic('JWT_EXPIRY_UNKNOWN', jwtStatus.reason, jwtStatus);
    }
    const headers = {
        'Accept':
            'application/json, text/plain, */*',
        'Accept-Language':
            'en-US,en;q=0.9',
        'Content-Type':
            'application/json',
        'Client-Device-Id':
            'WEB',
        'X-Requested-With':
            'XMLHttpRequest'
        // Browser fetch supplies Origin/Referer and session cookies from the
        // current IRCTC page context. Do not forge browser-controlled headers.
    };
    if (jwtToken) {
        headers['Authorization'] = `Bearer ${jwtToken}`;
        headers['jwttoken'] = jwtToken;
    }
    return headers;
}
    // SAFE RESPONSE PARSER
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
                console.error(
    '[API] Error: Received HTML instead of JSON. Possible Akamai block or redirect.'
);
                return null;
            }
            return JSON.parse(rawText);
        } catch (err) {
            console.error('[API] Parse error:', err.message);
            return null;
        }
    }
    // VALIDATE RESPONSE
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
    // TRAIN SEARCH
    async searchTrains(enquiryData) {
     this.sendProgress(
        'SEARCH TRAIN',
        'TRAIN SEARCHING...',
        20
    );
    if (!enquiryData || typeof enquiryData !== 'object') {
            throw new Error('Train search data invalid hai.');
        }
        this.sendBookingStatus(
    'From / To / Date ke basis par train search ho raha hai...',
    'SEARCH TRAIN',
    20
);
        const browserHealth = await this.getBrowserHealth();
        if (!browserHealth.connected) {
            this.sendDiagnostic('BROWSER_DISCONNECTED', browserHealth.reason, browserHealth);
            throw new Error(`[${this.browserType}] Browser unavailable: ${browserHealth.reason}`);
        }
        const cookies = await this.loadCookies();
const fromStation =
    enquiryData.fromStation ||
    enquiryData.from ||
    '--';
const toStation =
    enquiryData.toStation ||
    enquiryData.to ||
    '--';
const journeyDate =
    enquiryData.journeyDate ||
    enquiryData.date ||
    '--';
this.sendBookingStatus(
    `Train search: ${fromStation} → ${toStation} | Date: ${journeyDate}`,
    'SEARCH REQUEST',
    22
);
        const url = 'https://www.irctc.co.in/eticketing/protected/rcs/trainlitchk';
   const isFirefoxWEB4 =
    String(this.browserType).toUpperCase() === 'WEB4';
    // Sabhi browsers ke liye slow IRCTC navigation timeout
if (typeof this.page.setDefaultNavigationTimeout === 'function') {
    this.page.setDefaultNavigationTimeout(120000);
    console.log(`[AUTO LOGIN ${this.browserType}] Navigation timeout set to 120 seconds.`);
}
const headers = await this.getHeaders(
    cookies,
    isFirefoxWEB4
        ? 'https://www.irctc.co.in/eticket/train-search'
        : 'https://www.irctc.co.in/nget/booking/train-list'
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
            timeout: 120000
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
    await this.detectRetryPageStatus();
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
        await this.detectRetryPageStatus();
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
    // 1. CHECK AVAILABILITY AND FARE (BROWSER CONTEXT)
    async checkAvailabilityAndFare(bookingData) {
        await this.delay(1500);
        if (!this.page || this.page.isClosed()) {
            throw new Error(`[${this.browserType}] External browser page availability check ke liye available nahi hai.`);
        }
        const jDate = String(bookingData.journeyDate || bookingData.date || '').replace(/-/g, '');
        const fromStn = String(bookingData.fromStation || bookingData.from || '').trim().toUpperCase();
        const toStn = String(bookingData.toStation || bookingData.to || '').trim().toUpperCase();
        const classTp = String(bookingData.classType || bookingData.trainClass || bookingData.class || 'SL').trim().toUpperCase();
        const trainNo = String(bookingData.trainNo || bookingData.trainNumber || '').trim();
        const quotaRaw = String(bookingData.quota || 'GN').trim().toUpperCase();
        const quotaMap = {
            GENERAL: 'GN',
            TATKAL: 'TQ',
            'PREMIUM TATKAL': 'PT'
        };
        const quotaCd = quotaMap[quotaRaw] || quotaRaw;
        if (!/^\d{8}$/.test(jDate) || !fromStn || !toStn || !trainNo) {
            throw new Error('Availability check ke liye train number, stations ya journey date invalid/missing hai.');
        }
        // Use the latest usable token from the authenticated browser session.
        // getBrowserJwtToken also rejects a token whose JWT exp has passed.
        const accessToken = String(await this.getBrowserJwtToken() || '')
            .trim()
            .replace(/^Bearer\s+/i, '');
        if (!accessToken) {
            this.sendDiagnostic(
                'AVAILABILITY_AUTH_MISSING',
                'No usable IRCTC access token is available; availability request was not sent.',
                { browserType: this.browserType }
            );
            throw new Error('IRCTC login token missing/expired hai. Browser mein login/session verify karein.');
        }
        this.irctcAccessToken = accessToken;
        const requestData = {
            trainNo,
            jDate,
            fromStn,
            toStn,
            classTp,
            quotaCd,
            accessToken
        };
        const script = `
            (async () => {
                try {
                    const d = __REQUEST_DATA_PLACEHOLDER__;
                    const url = 'https://www.irctc.co.in/eticketing/protected/mapps1/avlFarenquiry/' +
                        encodeURIComponent(d.trainNo) + '/' +
                        encodeURIComponent(d.jDate) + '/' +
                        encodeURIComponent(d.fromStn) + '/' +
                        encodeURIComponent(d.toStn) + '/' +
                        encodeURIComponent(d.classTp) + '/' +
                        encodeURIComponent(d.quotaCd) + '/N';
                    const payload = {
                        classCode: d.classTp,
                        concessionBooking: false,
                        fromStnCode: d.fromStn,
                        ftBooking: false,
                        isLogedinReq: true,
                        journeyDate: d.jDate,
                        loyaltyRedemptionBooking: false,
                        moreThanOneDay: true,
                        paymentFlag: 'N',
                        quotaCode: d.quotaCd,
                        returnJourney: false,
                        ticketType: 'E',
                        toStnCode: d.toStn,
                        trainNumber: d.trainNo
                    };
                    const jwt = String(d.accessToken || '')
                        .trim()
                        .replace(/^Bearer\\s+/i, '');
                    if (!jwt) {
                        return {
                            status: 0,
                            error: 'Captured IRCTC access token is empty.'
                        };
                    }
                    const response = await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Accept': 'application/json, text/plain, */*',
                            'Accept-Language': 'en-US,en;q=0.9',
                            'Content-Type': 'application/json; charset=UTF-8',
                            'Authorization': 'Bearer ' + jwt,
                            'jwttoken': jwt,
                            'Client-Device-Id': 'WEB',
                            'Greq': String(Date.now()),
                            'Origin': 'https://www.irctc.co.in',
                            'Referer': 'https://www.irctc.co.in/nget/booking/availability'
                        },
                        credentials: 'include',
                        body: JSON.stringify(payload)
                    });
                    const body = await response.text();
                    return {
                        status: response.status,
                        body,
                        tokenSent: true,
                        tokenLength: jwt.length
                    };
                } catch (error) {
                    return {
                        status: 0,
                        error: error?.message || String(error)
                    };
                }
            })();
        `;
        const safeScript = script.replace(
            '__REQUEST_DATA_PLACEHOLDER__',
            JSON.stringify(requestData)
        );
        let lastResult = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            console.log(`[DEBUG] Browser-context POST avlFarenquiry attempt ${attempt} of 3...`);
            lastResult = await this.page.evaluate(safeScript);
            console.log('[AVAILABILITY AUTH]', {
                capturedToken: true,
                tokenLength: accessToken.length,
                tokenSource: 'login-response /authprovider/webtoken'
            });
            console.log(`[AVAILABILITY RAW] HTTP Status: ${lastResult?.status ?? 0}`);
            console.log(
                '[AVAILABILITY RAW BODY]',
                String(lastResult?.body || lastResult?.error || '').slice(0, 1200)
            );
            if (lastResult && lastResult.status === 200 && lastResult.body) {
                try {
                    return JSON.parse(lastResult.body);
                } catch (parseError) {
                    throw new Error(
                        'avlFarenquiry ne HTTP 200 diya, lekin response valid JSON nahi hai: ' +
                        parseError.message
                    );
                }
            }
            if (lastResult?.status === 401 || lastResult?.status === 403) {
                throw new Error(
                    `avlFarenquiry authentication failed | HTTP ${lastResult.status} | ` +
                    `${String(lastResult.body || '').slice(0, 700)}`
                );
            }
            if (attempt < 3) {
                await this.detectRetryPageStatus();
                await this.delay(1800);
            }
        }
        const finalStatus = Number(lastResult?.status || 0);
        const finalStatusInfo = this.classifyHttpStatus(finalStatus);
        this.sendDiagnostic(
            finalStatusInfo.category,
            `Availability/Fare enquiry failed after the existing retry sequence: ${finalStatusInfo.message}`,
            {
                endpoint: 'avlFarenquiry',
                status: finalStatus,
                responseLength: String(lastResult?.body || lastResult?.error || '').length,
                containsUnableToProcess: /unable to process request/i.test(String(lastResult?.body || ''))
            }
        );
        throw new Error(
            `avlFarenquiry failed | HTTP: ${finalStatus} | ${finalStatusInfo.message}`
        );
    }
    // 2. ALTERNATE AVAILABILITY ENQUIRY
    async checkAlternateAvailability(bookingData) {
        await this.delay(2000);
        if (!this.page || this.page.isClosed()) {
    throw new Error(
        `[${this.browserType}] External browser page available nahi hai alternate availability check ke liye.`
    );
}
        const alternateRequestData = {
            toStation: String(bookingData.toStation || bookingData.to || '').trim().toUpperCase(),
            journeyDate: String(bookingData.journeyDate || bookingData.date || '').replace(/-/g, ''),
            quota: String(bookingData.quota || 'GN').trim().toUpperCase(),
            fromStation: String(bookingData.fromStation || bookingData.from || '').trim().toUpperCase()
        };
        if (!/^\d{8}$/.test(alternateRequestData.journeyDate) ||
            !alternateRequestData.fromStation || !alternateRequestData.toStation) {
            throw new Error('Alternate availability payload mein station/date invalid hai.');
        }
        const script = `
            (async () => {
                try {
                    const d = __ALTERNATE_REQUEST_DATA__;
                    const url = "https://www.irctc.co.in/eticketing/protected/mapps1/altAvlEnq/TC";
                    const payload = {
                        concessionBooking: false,
                        currentBooking: "false",
                        destStn: d.toStation,
                        flexiFlag: false,
                        ftBooking: false,
                        handicapFlag: false,
                        jrnyClass: "",
                        jrnyDate: d.journeyDate,
                        loyaltyRedemptionBooking: false,
                        quotaCode: d.quota,
                        srcStn: d.fromStation,
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
                        credentials: "include",
                        body: JSON.stringify(payload)
                    });
                    const text = await response.text();
                    return { status: response.status, body: text };
                } catch (err) {
                    return { status: 0, error: err.message };
                }
            })();
        `.replace('__ALTERNATE_REQUEST_DATA__', JSON.stringify(alternateRequestData));
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
        await this.detectRetryPageStatus();
        await this.delay(2000);
        continue;
    }
                    throw new Error('altAvlEnq browser response empty ya invalid hai.');
                }
                return JSON.parse(result.body);
            } catch (error) {
    if (attempt >= maxRetries) {
        throw error;
    }
    await this.detectRetryPageStatus();
    await this.delay(2000);
}
        }
        throw new Error('altAvlEnq failed after maximum retries.');
    }
    // 3. MASTER PASSENGER LIST ENQUIRY
    async getMasterPassengerList() {
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
    await this.delay(1500);
    const passengers = Array.isArray(bookingData.passengers) ? bookingData.passengers : [];
    if (!passengers.length) throw new Error('Passenger list empty hai.');
    if (!this.win || !this.win.webContents) throw new Error('Browser window reference available nahi hai.');
    const backendRealFare = String(bookingData.realFare || bookingData.fare || "0");
    const targetTrainNo = String(bookingData.trainNo || "");
    const rawPayload = JSON.stringify({
    targetTrainNo: targetTrainNo,
    browserType: this.browserType,
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
// WEB4 BETA: IRCTC TOAST ERROR DETECTOR
function getWEB4ToastError() {
    var toastDetails = Array.from(
        document.querySelectorAll('.ui-toast-detail')
    );
    for (var i = 0; i < toastDetails.length; i++) {
        var message = (
            toastDetails[i].innerText ||
            toastDetails[i].textContent ||
            ''
        ).replace(/\s+/g, ' ').trim();
        if (
            /high load|unable to process(?: the)? request|please retry/i.test(message)
        ) {
            return message;
        }
    }
    return '';
}
    // LIVE BOOKING STATUS -> NODE -> ELECTRON UI
async function liveProgress(step, message, percentage) {
    diagnosticLogs.push(
        '[LIVE PROGRESS] ' + step + ': ' + message
    );
    console.log(
        '[LIVE PROGRESS DEBUG] Sending:',
        step,
        message,
        percentage
    );
    try {
        if (
            typeof window.__bossSendProgress !== 'function'
        ) {
            console.warn(
                '[LIVE PROGRESS] Bridge unavailable:',
                'window.__bossSendProgress is not a function'
            );
            diagnosticLogs.push(
                '[LIVE PROGRESS] Bridge unavailable.'
            );
            return false;
        }
        await window.__bossSendProgress(
            step,
            message,
            percentage
        );
        console.log(
            '[LIVE PROGRESS DEBUG] Bridge call completed:',
            step,
            message,
            percentage
        );
        return true;
    } catch (progressError) {
        console.error(
            '[LIVE PROGRESS] Bridge error:',
            progressError
        );
        diagnosticLogs.push(
            '[LIVE PROGRESS] Bridge error: ' +
            (
                progressError &&
                progressError.message
                    ? progressError.message
                    : String(progressError)
            )
        );
        return false;
    }
}
        try {
var currentUrl = window.location.href;
diagnosticLogs.push("Current Browser URL: " + currentUrl);
// WEB4 SAFETY: Payment provider page par train-search dobara start mat karo.
if (
    String(payload.browserType || '').toUpperCase() === 'WEB4' &&
    window.location.hostname !== 'www.irctc.co.in'
) {
    diagnosticLogs.push(
        '[WEB4 GUARD] External payment page detected. ' +
        'Train-search redirect skipped: ' + window.location.href
    );
    return {
        success: true,
        paymentPageDetected: true,
        message: 'WEB4 payment page detected. Continuing QR verification.',
        logs: diagnosticLogs
    };
}
// Firefox Beta (WEB4) par eticket page hi rakhein.
// Baaki browsers ka existing nget flow nahi badlega.
var isFirefoxWEB4 =
    String(payload.browserType || '').toUpperCase() === 'WEB4';
var trainSearchUrl = isFirefoxWEB4
    ? 'https://www.irctc.co.in/eticket/train-search'
    : 'https://www.irctc.co.in/nget/train-search';
if (window.location.hostname !== 'www.irctc.co.in') {
    diagnosticLogs.push(
        "Navigating to IRCTC train search page: " + trainSearchUrl
    );
    window.location.href = trainSearchUrl;
    await new Promise(function(r) {
        setTimeout(r, 2000);
    });
} else {
    await new Promise(function(r) {
        setTimeout(r, 500);
    });
}
await liveProgress(
    'TRAIN SEARCH',
    'Journey details bhar rahe hain...',
    22
);
            // 1. Fill Stations
            diagnosticLogs.push("Filling From/To station details...");
            var isFirefoxWEB4Stations =
                String(payload.browserType || '').toUpperCase() === 'WEB4';
            if (isFirefoxWEB4Stations) {
                async function selectFirefoxWEB4Station(label, stationCode) {
                    var combo = document.querySelector(
                        'app-jp-input [role="combobox"][aria-label="' + label + '"]'
                    );
                    if (!combo) {
                        throw new Error('Firefox  ' + label + ' field nahi mila.');
                    }
                    combo.click();
                    await new Promise(function(r) { setTimeout(r, 250); });
                    var searchInput = Array.from(
                        document.querySelectorAll('input[placeholder="Type to search..."]')
                    ).find(function(input) {
                        return input.getClientRects().length > 0;
                    });
                    if (!searchInput) {
                        throw new Error('Firefox  ' + label + ' search input nahi mila.');
                    }
                    searchInput.focus();

var firefoxSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
).set;

var firefoxText = String(stationCode).trim();

// Pura station code ek saath fill karein
firefoxSetter.call(searchInput, firefoxText);

searchInput.dispatchEvent(
    new Event('input', { bubbles: true })
);

searchInput.dispatchEvent(
    new Event('change', { bubbles: true })
);

                    await new Promise(function(r) { setTimeout(r, 500); });
                    var options = Array.from(
                        document.querySelectorAll('[role="option"]')
                    ).filter(function(el) {
                        return el.getClientRects().length > 0;
                    });
                    var wantedCode = stationCode.trim().toUpperCase();
                    var match = options.find(function(el) {
                        var text = (el.innerText || el.textContent || '')
                            .trim().toUpperCase();
                        return text === wantedCode ||
                            new RegExp(
                                '(^|[^A-Z])' + wantedCode + '([^A-Z]|$)'
                            ).test(text);
                    });
                    if (!match) {
                        diagnosticLogs.push(
                            'Firefox  ' + label + ' options: ' +
                            options.map(function(el) {
                                return (el.innerText || el.textContent || '').trim();
                            }).join(' | ')
                        );
                        throw new Error(
                            label + ' station code option nahi mila: ' + stationCode
                        );
                    }
                    diagnosticLogs.push(
                        label + ' option selecting: ' +
                        (match.innerText || match.textContent || '').trim()
                    );
                    match.click();
                    await new Promise(function(r) { setTimeout(r, 400); });
                }
                try {
                    if (payload.fromStation) {
                        await selectFirefoxWEB4Station(
                            'From station',
                            payload.fromStation
                        );
                    }
                    if (payload.toStation) {
                        await selectFirefoxWEB4Station(
                            'To station',
                            payload.toStation
                        );
                    }
                    diagnosticLogs.push('Firefox  From/To stations selected.');
                } catch (e) {
                    diagnosticLogs.push(
                        'Firefox  station selection FAILED: ' + e.message
                    );
                    return {
                        success: false,
                        error: e.message,
                        logs: diagnosticLogs
                    };
                }
            } else {
// WEB, WEB2 and WEB3 - Standard station autofill
function getStationInputs() {
    var inputs = Array.from(
        document.querySelectorAll('p-autocomplete input')
    );
    if (inputs.length < 2) {
        inputs = Array.from(
            document.querySelectorAll('input')
        ).filter(function(input) {
            var ph = (
                input.getAttribute('placeholder') || ''
            ).toUpperCase();
            var ar = (
                input.getAttribute('aria-label') || ''
            ).toUpperCase();
            return ph.includes('FROM') ||
                ph.includes('TO') ||
                ar.includes('FROM') ||
                ar.includes('TO');
        });
    }
    return inputs;
}
async function setStationValue(input, value) {
    if (!input) {
        throw new Error('Station input nahi mila.');
    }
    input.click();
    input.focus();
    var setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
    ).set;
    // Pehle field clear karein
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    
var text = String(value || '').trim();

// Pura station name ek saath fill karein
setter.call(input, text);

input.dispatchEvent(
    new Event('input', { bubbles: true })
);

input.dispatchEvent(
    new Event('change', { bubbles: true })
);
}
async function selectFirstStationSuggestion() {
    await new Promise(function(resolve) {
        setTimeout(resolve, 600);
    });
    var panel = document.querySelector(
        'ul.ui-autocomplete-items, ' +
        'ul.p-autocomplete-items, ' +
        '.ui-autocomplete-panel, ' +
        '.p-autocomplete-panel'
    );
    if (!panel) {
        throw new Error('Station suggestions panel nahi mila.');
    }
    var firstItem = panel.querySelector('li');
    if (!firstItem) {
        throw new Error('Station suggestion nahi mili.');
    }
    firstItem.click();
    await new Promise(function(resolve) {
        setTimeout(resolve, 300);
    });
}
// FROM
if (payload.fromStation) {
    var fromInput = getStationInputs()[0];
    await setStationValue(fromInput, payload.fromStation);
    await selectFirstStationSuggestion();
}
// TO - re-query after From selection
if (payload.toStation) {
    var refreshedInputs = getStationInputs();
    var toInput = refreshedInputs[1];
    if (!toInput) {
        throw new Error('To station input nahi mila.');
    }
    await setStationValue(toInput, payload.toStation);
    await selectFirstStationSuggestion();
}
            }
     await liveProgress(
    'JOURNEY DATE',
    'Journey details bhar rahe hain...',
    24
);
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
                    var isFirefoxWEB4 =
    String(payload.browserType || '').trim().toUpperCase() === 'WEB4';
var calendarTrigger;
if (isFirefoxWEB4) {
    calendarTrigger = Array.from(
        document.querySelectorAll('.field-inner')
    ).find(function(field) {
        var label = field.querySelector('.field-label');
        return label &&
            (label.innerText || label.textContent || '')
                .trim().toLowerCase() === 'date';
    });
} else {
    calendarTrigger =
        document.querySelector('p-calendar button') ||
        document.querySelector('p-calendar input') ||
        document.querySelector('.ui-calendar button');
}
diagnosticLogs.push(
    'Journey Date: calendar trigger found = ' + !!calendarTrigger
);
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
                            await new Promise(function(r) { setTimeout(r, 300); });
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
    var quotaDropdown = null;
    var isFirefoxWEB4 = String(payload.browserType || '')
        .toUpperCase() === 'WEB4';
    if (isFirefoxWEB4) {
        quotaDropdown = document.querySelector(
            'app-jp-input [role="combobox"][aria-label="Quota"]'
        );
        if (!quotaDropdown) {
            throw new Error('Firefox  ka Quota field nahi mila.');
        }
        quotaDropdown.click();
        await new Promise(function(resolve) {
            setTimeout(resolve, 300);
        });
        var target = Array.from(
            document.querySelectorAll('[role="option"]')
        ).find(function(el) {
            return (el.innerText || el.textContent || '')
                .trim().toUpperCase() === wanted;
        });
        if (!target) {
            throw new Error('Quota option nahi mila: ' + wanted);
        }
        target.click();
        await new Promise(function(resolve) {
            setTimeout(resolve, 400);
        });
        var selected = (
            quotaDropdown.innerText ||
            quotaDropdown.textContent ||
            ''
        ).toUpperCase();
        diagnosticLogs.push(
            'Firefox  quota selected value: ' + selected.trim()
        );
        if (!selected.includes(wanted)) {
            throw new Error('Quota select verify nahi hua.');
        }
    } else {
        // WEB, WEB2 aur WEB3 ka existing logic yahan rehna chahiye.
        quotaDropdown =
            document.querySelector('p-dropdown[formcontrolname="journeyQuota"]') ||
            document.querySelector('p-dropdown[formcontrolname="quota"]') ||
            document.querySelector('#journeyQuota');
        if (!quotaDropdown) {
            throw new Error('Quota dropdown nahi mila.');
        }
        (quotaDropdown.querySelector('.p-dropdown, .ui-dropdown') ||
            quotaDropdown).click();
        await new Promise(function(resolve) {
            setTimeout(resolve, 300);
        });
        var items = Array.from(document.querySelectorAll(
            '.p-dropdown-panel li, .ui-dropdown-panel li, .p-dropdown-item, .ui-dropdown-item'
        ));
        var oldTarget = items.find(function(el) {
            return (el.innerText || el.textContent || '')
                .trim().toUpperCase() === wanted;
        });
        if (!oldTarget) {
            throw new Error('Option nahi mila: ' + wanted);
        }
        oldTarget.click();
        await new Promise(function(resolve) {
            setTimeout(resolve, 300);
        });
        var oldSelected = (
            quotaDropdown.querySelector(
                '.p-dropdown-label, .ui-dropdown-label'
            )?.innerText || ''
        ).trim().toUpperCase();
        if (!oldSelected.includes(wanted)) {
            throw new Error('Quota select verify nahi hua.');
        }
    }
    diagnosticLogs.push('Quota successfully selected: ' + wanted);
} catch (e) {
    diagnosticLogs.push('Quota selection FAILED: ' + e.message);
    return {
        success: false,
        error: 'Quota select nahi hua: ' + e.message,
        logs: diagnosticLogs
    };
}
await liveProgress(
    'SEARCH BUTTON',
    'Search Train...',
    26
);
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
    await liveProgress(
    'SEARCH STARTED',
    'Search Train...',
    40
);
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
await liveProgress(
    'SEARCH RESULTS',
    'Train search sucessefully...',
    28
);
// 4. WAIT FOR TRAIN LIST + EXACT TRAIN
diagnosticLogs.push(
    "Waiting for train list and searching for exact train number: " +
    payload.targetTrainNo
);
await liveProgress(
    'TRAIN SEARCH',
    'Target train search ki ja rahi hain...',
    42
);
var bookNowClicked = false;
var targetCard = null;
var classSelectionCompleted = false;
// WEB4 (Firefox / IRCTC Beta) availability state
var firefoxAvailabilityOpened = false;
attempts = 0;
var journeyDateMissingRetries = 0;
while (
    attempts < 20 &&
    journeyDateMissingRetries < 20 &&
    !bookNowClicked
) {
    // Find exact train card
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
    // Fallback exact train search
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
    // TARGET TRAIN FOUND
    if (targetCard) {
        await liveProgress(
    'TRAIN FOUND',
    'Target train mil gayi hain...',
    30
);
        diagnosticLogs.push(
            "Exact target train card found for number: " +
            payload.targetTrainNo
        );
         diagnosticLogs.push(
        "FIND TRAIN: Exact target train found."
    );
        // TATKAL OPENING-TIME WAIT
        // WEB4-ONLY STATUS FIX
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
        var isWEB4Beta =
            String(payload.browserType || '')
                .trim()
                .toUpperCase() === 'WEB4';
        // WEB, WEB2 aur WEB3 ka purana behavior same rahega.
        // WEB4 mein Tatkal status sirf Tatkal quota par.
        if (!isWEB4Beta || isTatkalQuota) {
            await liveProgress(
                'TATKAL WAIT',
                'Tatkal opening time check ho raha hain...',
                32
            );
        } else {
            // WEB4 + GENERAL quota
            await liveProgress(
                'TRAIN FOUND',
                'General quota: train select kar rahe hain...',
                32
            );
        }
if (isTatkalQuota) {
    // AC Tatkal = 10:00:02 AM
    // Non-AC Tatkal = 11:00:02 AM
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
    var tatkalHour = isACClass ? 10 : 11;
    var tatkalMinute = 0;
    var tatkalSecond = 2;
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
                ? "10:00:02 AM"
                : "11:00:02 AM"
        )
    );
    // WAIT UNTIL EXACT OPENING TIME
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
// LIVE COUNTDOWN - UI UPDATE ONCE PER SECOND
var mins = Math.floor(remaining / 60);
var secs = remaining % 60;
var timerText =
    'waiting for tatkal window opening.... ' +
    String(mins).padStart(2, '0') +
    'm ' +
    String(secs).padStart(2, '0') +
    's';
// Sirf jab displayed second change ho tab UI update karo
if (typeof window.__bossTatkalLastSecond === 'undefined') {
    window.__bossTatkalLastSecond = -1;
}
if (secs !== window.__bossTatkalLastSecond) {
    window.__bossTatkalLastSecond = secs;
    // Progress bridge ko await nahi karenge.
    // Isse Tatkal countdown ke waqt long-running
    // Runtime.evaluate par unnecessary CDP load nahi padega.
    try {
        if (
            typeof window.__bossSendProgress === 'function'
        ) {
            window.__bossSendProgress(
                'TATKAL WAIT',
                timerText,
                35
            ).catch(function() {});
        }
    } catch (e) {}
}
        // Last 5 seconds:
        // much shorter polling
        if (remaining <= 5) {
    // Last 5 seconds: accurate but unnecessary
    // 100ms CDP/browser loop avoid karna hai.
    await new Promise(function(r) {
        setTimeout(r, 250);
    });
} else {
    await new Promise(function(r) {
        setTimeout(r, 500);
    });
}
    }
    await liveProgress(
    'TATKAL OPEN',
    'Train select kar rahe hain...',
    40
);
}
        // 🔥 FIX: DATE OF JOURNEY / AVAILABILITY BOX SELECTION
        // (Sirf targetCard ke andar search karega taaki doosri train touch na ho)
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
// WEB4 ONLY: CHECK AVAILABILITY WITH FRESH DOM RETRIES
var isFirefoxWEB4 =
    String(payload.browserType || '')
        .trim()
        .toUpperCase() === 'WEB4';
if (isFirefoxWEB4) {
    var availabilityRetryLimit = 20;
    var availabilitySucceeded = false;
// WEB4 ONLY: Find exact train card using actual IRCTC DOM
function findWEB4AvailabilityTrainCard() {
    var cards = Array.from(
        document.querySelectorAll('div.train-card')
    );
    for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var trainNumberElement = card.querySelector(
            '.train-header .train-number'
        );
        if (!trainNumberElement) continue;
        var actualTrainNumber = (
            trainNumberElement.innerText ||
            trainNumberElement.textContent ||
            ''
        ).trim();
        if (actualTrainNumber === String(payload.targetTrainNo).trim()) {
            return card;
        }
    }
    return null;
}
function waitForWEB4TrainCard(timeoutMs) {
    return new Promise(function(resolve) {
        // Pehle turant check karo
        var card = findWEB4AvailabilityTrainCard();
        if (card) {
            resolve(card);
            return;
        }
        // Train card DOM mein aate hi detect karo
        var observer = new MutationObserver(function() {
            var foundCard = findWEB4AvailabilityTrainCard();
            if (foundCard) {
                observer.disconnect();
                resolve(foundCard);
            }
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
        // Safety timeout: maximum 10 seconds
        setTimeout(function() {
            observer.disconnect();
            resolve(findWEB4AvailabilityTrainCard());
        }, timeoutMs || 10000);
    });
}
    for (
        var availabilityTry = 1;
        availabilityTry <= availabilityRetryLimit;
        availabilityTry++
    ) {
        diagnosticLogs.push(
            'WEB4: Availability attempt ' +
            availabilityTry + '/' +
            availabilityRetryLimit
        );
        // Fresh train card search.
targetCard = await waitForWEB4TrainCard(10000);
if (!targetCard || !targetCard.isConnected) {
    diagnosticLogs.push(
        'WEB4: Target train card 10 seconds mein DOM mein nahi mila.'
    );
    continue;
}
        // Button ko fresh DOM se search karo.
        var availabilityButton = Array.from(
    targetCard.querySelectorAll('button')
).find(function(btn) {
    var text = (
        btn.innerText ||
        btn.textContent ||
        ''
    )
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
    return (
        text === 'CHECK AVAILABILITY' ||
        text === 'REFRESH AVAILABILITY'
    ) && btn.getClientRects().length > 0;
});
        // Button nahi mila to fail mat karo.
        // Agle attempt mein fresh DOM search hogi.
        if (!availabilityButton) {
            diagnosticLogs.push(
                'WEB4: Check Availability button nahi mila. ' +
                'Attempt retry hoga.'
            );
            await new Promise(function(resolve) {
                setTimeout(resolve, 3000);
            });
            continue;
        }
        if (availabilityButton.disabled) {
            diagnosticLogs.push(
                'WEB4: Availability button disabled hai. Waiting...'
            );
            await new Promise(function(resolve) {
                setTimeout(resolve, 3000);
            });
            continue;
        }
        var buttonText = (
            availabilityButton.innerText ||
            availabilityButton.textContent ||
            ''
        )
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
        diagnosticLogs.push(
            'WEB4: Clicking ' + buttonText
        );
        try {
            availabilityButton.scrollIntoView({
                behavior: 'auto',
                block: 'center'
            });
        } catch (e) {}
        await new Promise(function(resolve) {
            setTimeout(resolve, 300);
        });
        // Click se pehle button dobara verify karo.
        if (
            !availabilityButton.isConnected ||
            availabilityButton.disabled
        ) {
            diagnosticLogs.push(
                'WEB4: Button DOM se change ho gaya. Fresh retry hoga.'
            );
            continue;
        }
        await new Promise(function(resolve) {
            setTimeout(resolve, 600);
        });
        availabilityButton.click();
        diagnosticLogs.push(
            'WEB4: Availability click sent. Result ka wait kar rahe hain...'
        );
        var retryErrorFound = false;
        var betaClassesLoaded = false;
        // 80 x 250ms = maximum 20 seconds wait.
        for (var waitIndex = 0; waitIndex < 80; waitIndex++) {
            await new Promise(function(resolve) {
                setTimeout(resolve, 250);
            });
            // Angular re-render ke baad fresh card lo.
            var refreshedTargetCard =
                findWEB4AvailabilityTrainCard();
            if (refreshedTargetCard) {
                targetCard = refreshedTargetCard;
            }
            var pageText = (
                document.body
                    ? (
                        document.body.innerText ||
                        document.body.textContent ||
                        ''
                    )
                    : ''
            ).toLowerCase();
            var web4ToastError = '';
            try {
                web4ToastError =
                    String(getWEB4ToastError() || '').toLowerCase();
            } catch (e) {}
            retryErrorFound =
                web4ToastError.includes('unable to process request') ||
                web4ToastError.includes('high load') ||
                pageText.includes('high load') ||
                pageText.includes('unable to process request') ||
                pageText.includes('unable to process the request') ||
                pageText.includes('please retry');
            if (retryErrorFound) {
                break;
            }
            // Exact train card ke class cards verify karo.
            var currentClassCards = targetCard
                ? targetCard.querySelectorAll('.class-card')
                : [];
            if (
                currentClassCards &&
                currentClassCards.length > 0
            ) {
                betaClassesLoaded = true;
                break;
            }
        }
        // Availability successfully loaded -> Read Live Availability & Fare from DOM
        if (betaClassesLoaded) {
            availabilitySucceeded = true;
            try {
                var reqCls = String(payload.trainClass || 'SL').trim().toUpperCase();
                var matchedBetaCard = Array.from(targetCard.querySelectorAll('.class-card')).find(function(c) {
                    return (c.innerText || '').toUpperCase().includes('(' + reqCls + ')');
                }) || targetCard.querySelector('.class-card');

                if (matchedBetaCard && typeof window.__bossSendAvlFare === 'function') {
                    var cardTxt = (matchedBetaCard.innerText || '').replace(/\s+/g, ' ').trim();
                    var avlMatch = cardTxt.match(/\b((?:AVAILABLE|AVL|TQWL|GNWL|RLWL|PQWL|RQWL|RSWL|WL|RAC|REGRET|NOT AVAILABLE)[\s-]*\d*(?:\s*\/\s*(?:WL|RAC)?\s*\d+)?)\b/i);
                    var fareMatch = cardTxt.match(/(?:₹|Rs\.?)\s*([\d,]+(?:\.\d{1,2})?)/i);
                    var liveAvl = avlMatch ? avlMatch[1].trim() : 'AVAILABLE';
                    var liveFare = fareMatch ? '₹' + fareMatch[1].trim() : '--';
                    window.__bossSendAvlFare(liveAvl, liveFare).catch(function() {});
                    diagnosticLogs.push('WEB4 DOM Live Data -> Avl: ' + liveAvl + ' | Fare: ' + liveFare);
                }
            } catch (_) {}

            diagnosticLogs.push(
                'WEB4: Availability successfully loaded. Class cards found: ' +
                targetCard.querySelectorAll('.class-card').length
            );
            break;
        }
        // Explicit IRCTC error.
        if (retryErrorFound) {
            diagnosticLogs.push(
                'WEB4: IRCTC High Load / Unable to Process error detected.'
            );
            var availabilityErrorClose = document.querySelector(
                'a.ui-toast-close-icon.pi.pi-times'
            );
            if (availabilityErrorClose) {
                try {
                    availabilityErrorClose.click();
                } catch (e) {}
            }
        } else {
            diagnosticLogs.push(
                'WEB4: 20 seconds wait ke baad bhi class cards load nahi hue.'
            );
        }
        // Last attempt ke baad stop.
        if (availabilityTry >= availabilityRetryLimit) {
            diagnosticLogs.push(
                'WEB4: Maximum 20 Availability attempts completed.'
            );
            break;
        }
        diagnosticLogs.push(
            'WEB4: 2 seconds wait karke Availability dobara check hogi.'
        );
        await new Promise(function(resolve) {
            setTimeout(resolve, 3000);
        });
    }
    // Safety gate: class selection tabhi chale jab cards load hon.
    if (!availabilitySucceeded) {
        diagnosticLogs.push(
            'WEB4: Availability 20 attempts ke baad bhi load nahi hui. Booking safely stopped.'
        );
        return {
            success: false,
            error: 'WEB4: Availability 20 retries ke baad bhi load nahi hui; class selection/BOOK safely stop kar diya.',
            logs: diagnosticLogs
        };
    }
}
        var targetClass = String(
            payload.trainClass || ''
        ).trim().toUpperCase();
        if (!targetClass) {
            return {
                success: false,
                error: 'trainClass missing from payload',
                logs: diagnosticLogs
            };
        }
        var isFirefoxWEB4 =
            String(payload.browserType || '')
                .trim()
                .toUpperCase() === 'WEB4';
        var classNames = {
            'SL': 'SLEEPER',
            '3E': 'AC 3 ECONOMY',
            '3A': 'AC 3 TIER',
            '2A': 'AC 2 TIER',
            '1A': 'AC FIRST CLASS'
        };
        var wantedClassName =
            classNames[targetClass] || targetClass;
        var matchedClassBox = null;
        if (isFirefoxWEB4) {
            // Beta page par har class ek .class-card hai.
            var betaClassCards = Array.from(
                targetCard.querySelectorAll('.class-card')
            );
            matchedClassBox = betaClassCards.find(function(card) {
                var code = card.querySelector('.class-code');
                var text = (
                    code
                        ? (code.innerText || code.textContent || '')
                        : ''
                ).replace(/\s+/g, ' ').trim().toUpperCase();
                return text === wantedClassName + ' (' + targetClass + ')';
            });
            if (!matchedClassBox) {
                diagnosticLogs.push(
                    'WEB4 Beta: Requested class card not found: ' +
                    targetClass
                );
                diagnosticLogs.push(
                    'WEB4 Beta classes visible: ' +
                    betaClassCards.map(function(card) {
                        var code = card.querySelector('.class-code');
                        return code
                            ? (code.innerText || code.textContent || '').trim()
                            : '(class name missing)';
                    }).join(' | ')
                );
                attempts++;
                await new Promise(function(resolve) {
                    setTimeout(resolve, 500);
                });
                continue;
            }
            diagnosticLogs.push(
                'WEB4 Beta: Exact class card found: ' + targetClass
            );
            // Beta class card mein dedicated selected-state HTML
            // abhi supplied snippet mein nahi hai. BOOK button ki
            // availability ko class card ke saath verify karte hain.
            var betaBookButton = matchedClassBox.querySelector(
                'button.btn-book'
            );
            if (!betaBookButton) {
                diagnosticLogs.push(
                    'WEB4 Beta: Class card mila, lekin BOOK button abhi nahi hai.'
                );
                attempts++;
                await new Promise(function(resolve) {
                    setTimeout(resolve, 500);
                });
                continue;
            }
            // WEB4: Scroll ko minimum rakho; page ko baar-baar move mat karo.
try {
    matchedClassBox.scrollIntoView({
        behavior: 'instant',
        block: 'nearest',
        inline: 'nearest'
    });
} catch (e) {}
await new Promise(function(resolve) {
    setTimeout(resolve, 200);
});
// Card ka exact class code dobara verify karo.
var verifyClassCode = matchedClassBox.querySelector('.class-code');
var verifyClassText = (
    verifyClassCode
        ? (verifyClassCode.innerText || verifyClassCode.textContent || '')
        : ''
).replace(/\s+/g, ' ').trim().toUpperCase();
if (verifyClassText !== wantedClassName + ' (' + targetClass + ')') {
    diagnosticLogs.push(
        'WEB4: Class changed before click. Expected ' +
        wantedClassName + ' (' + targetClass + '), found ' +
        verifyClassText
    );
    attempts++;
    await new Promise(function(resolve) {
        setTimeout(resolve, 500);
    });
    continue;
}
// Class card par click karo.
matchedClassBox.click();
await new Promise(function(resolve) {
    setTimeout(resolve, 500);
});
diagnosticLogs.push(
    'WEB4: Click sent to exact class card ' + targetClass
);
            // Card re-render ho sakta hai; fresh card locate karo.
            var refreshedBetaCards = Array.from(
                document.querySelectorAll('.class-card')
            );
            matchedClassBox = refreshedBetaCards.find(function(card) {
                var code = card.querySelector('.class-code');
                var text = (
                    code
                        ? (code.innerText || code.textContent || '')
                        : ''
                ).replace(/\s+/g, ' ').trim().toUpperCase();
                return text === wantedClassName + ' (' + targetClass + ')';
            }) || matchedClassBox;
            betaBookButton = matchedClassBox
                ? matchedClassBox.querySelector('button.btn-book')
                : null;
            if (!betaBookButton) {
                diagnosticLogs.push(
                    'WEB4 Beta: Class card refresh ke baad BOOK button nahi mila.'
                );
                attempts++;
                await new Promise(function(resolve) {
                    setTimeout(resolve, 500);
                });
                continue;
            }
// WEB4 ONLY: BOOK RETRY - MAX 10 ATTEMPTS
var web4BookSuccess = false;
var web4BookRetryLimit = 10;
for (
    var web4BookTry = 1;
    web4BookTry <= web4BookRetryLimit;
    web4BookTry++
) {
    // Passenger page already open? Stop immediately.
    if (
        window.location.href.toLowerCase().includes('psgninput') ||
        document.querySelector('button.btn.btn-new-passenger') ||
        document.querySelector(
            'input[formcontrolname="passengerName"]'
        )
    ) {
        web4BookSuccess = true;
        break;
    }
    // Exact requested class card dobara find karo.
    var retryClassCards = Array.from(
        targetCard.querySelectorAll('.class-card')
    );
    var retryMatchedCard = retryClassCards.find(function(card) {
        var code = card.querySelector('.class-code');
        var text = (
            code
                ? (code.innerText || code.textContent || '')
                : ''
        ).replace(/\s+/g, ' ').trim().toUpperCase();
        return text === wantedClassName + ' (' + targetClass + ')';
    });
    var retryBookButton = retryMatchedCard
        ? retryMatchedCard.querySelector('button.btn-book')
        : null;
    if (!retryMatchedCard || !retryBookButton || retryBookButton.disabled) {
        diagnosticLogs.push(
            'WEB4: Requested class/BOOK button unavailable on attempt ' +
            web4BookTry
        );
        break;
    }
    diagnosticLogs.push(
        'WEB4: BOOK attempt ' +
        web4BookTry + '/' + web4BookRetryLimit
    );
    try {
        retryMatchedCard.scrollIntoView({
            behavior: 'auto',
            block: 'nearest'
        });
    } catch (e) {}
    await new Promise(function(resolve) {
        setTimeout(resolve, 200);
    });
    // Fresh button check before click.
    retryBookButton = retryMatchedCard.querySelector('button.btn-book');
    if (!retryBookButton || retryBookButton.disabled) {
        diagnosticLogs.push(
            'WEB4: BOOK button disabled before click.'
        );
        break;
    }
    retryBookButton.click();
    diagnosticLogs.push(
        'WEB4: BOOK click sent for class ' + targetClass
    );
    // Wait for passenger page or explicit IRCTC error.
    var web4PassengerFormReady = false;
    var web4RetryErrorFound = false;
    for (var web4Wait = 0; web4Wait < 40; web4Wait++) {
        await new Promise(function(resolve) {
            setTimeout(resolve, 250);
        });
        var currentUrl = window.location.href.toLowerCase();
        var passengerButton = document.querySelector(
            'button.btn.btn-new-passenger'
        );
        var passengerName = document.querySelector(
            'input[formcontrolname="passengerName"], ' +
            'input[placeholder*="Full Name"], ' +
            'input[placeholder*="Govt"]'
        );
        if (
            currentUrl.includes('psgninput') ||
            passengerButton ||
            passengerName
        ) {
            web4PassengerFormReady = true;
            break;
        }
        var currentPageText = (
            document.body.innerText ||
            document.body.textContent ||
            ''
        ).toLowerCase();
        var web4BookToastError =
    getWEB4ToastError().toLowerCase();
web4RetryErrorFound =
    web4BookToastError.includes('unable to process request') ||
    currentPageText.includes('high load') ||
    currentPageText.includes('unable to process request') ||
    currentPageText.includes('unable to process the request') ||
    currentPageText.includes('please retry');
        if (web4RetryErrorFound) {
            break;
        }
    }
    // Passenger page success: never click BOOK again.
    if (web4PassengerFormReady) {
        web4BookSuccess = true;
        bookNowClicked = true;
        diagnosticLogs.push(
            'WEB4: Passenger page confirmed. BOOK retry stopped.'
        );
        break;
    }
    // Retry ONLY when an explicit IRCTC error is detected.
    if (!web4RetryErrorFound) {
        diagnosticLogs.push(
            'WEB4: No confirmed IRCTC error and passenger page not detected. ' +
            'Stopping to avoid duplicate BOOK click.'
        );
        break;
    }
    diagnosticLogs.push(
        'WEB4: IRCTC BOOK error detected.'
    );
    if (web4BookTry >= web4BookRetryLimit) {
        diagnosticLogs.push(
            'WEB4: Maximum 10 BOOK attempts reached.'
        );
        break;
    }
    // WEB4: BOOK error ke baad retry se pehle 3 seconds wait.
diagnosticLogs.push(
    'WEB4: BOOK error detected. 3 seconds wait karke retry start hoga.'
);
await new Promise(function(resolve) {
    setTimeout(resolve, 3000);
});
    // Same train ka Refresh Availability button.
    var refreshAvailabilityButton = Array.from(
        targetCard.querySelectorAll('button.btn-availability')
    ).find(function(btn) {
        var text = (
            btn.innerText || btn.textContent || ''
        ).replace(/\s+/g, ' ').trim().toUpperCase();
        return text.includes('REFRESH AVAILABILITY');
    });
    if (!refreshAvailabilityButton) {
        diagnosticLogs.push(
            'WEB4: Refresh Availability button not found. Retry stopped.'
        );
        break;
    }
    diagnosticLogs.push(
        'WEB4: Refresh Availability clicked after BOOK error.'
    );
    refreshAvailabilityButton.click();
    // Wait for refreshed class cards.
    var refreshedClassesReady = false;
    for (var refreshWait = 0; refreshWait < 40; refreshWait++) {
        await new Promise(function(resolve) {
            setTimeout(resolve, 250);
        });
        var refreshedClassCards = targetCard.querySelectorAll('.class-card');
        if (refreshedClassCards.length > 0) {
            refreshedClassesReady = true;
            break;
        }
    }
    if (!refreshedClassesReady) {
        diagnosticLogs.push(
            'WEB4: Classes did not reload after Refresh Availability.'
        );
        break;
    }
    // Next loop requested class ko dobara locate/select karke BOOK karega.
    var classAfterRefresh = Array.from(
        targetCard.querySelectorAll('.class-card')
    ).find(function(card) {
        var code = card.querySelector('.class-code');
        var text = (
            code
                ? (code.innerText || code.textContent || '')
                : ''
        ).replace(/\s+/g, ' ').trim().toUpperCase();
        return text === wantedClassName + ' (' + targetClass + ')';
    });
    if (!classAfterRefresh) {
        diagnosticLogs.push(
            'WEB4: Requested class not found after refresh.'
        );
        break;
    }
    classAfterRefresh.click();
    await new Promise(function(resolve) {
        setTimeout(resolve, 500);
    });
    diagnosticLogs.push(
        'WEB4: Requested class ' + targetClass +
        ' reselected after refresh.'
    );
}
if (web4BookSuccess) {
    bookNowClicked = true;
    diagnosticLogs.push(
        'WEB4: BOOK process successful. Passenger page reached.'
    );
} else {
    bookNowClicked = false;
    diagnosticLogs.push(
        'WEB4: BOOK retry process stopped without passenger page confirmation.'
    );
}
            classSelectionCompleted = true;
} else {
    // WEB / WEB2 / WEB3: ORIGINAL CLASS-SELECTION LOGIC
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
        text.indexOf(wantedClassName) !== -1 &&
        text.indexOf('(' + targetClass + ')') !== -1;
    if (!exactClassText) {
        continue;
    }
    var smallerChildren = Array.from(
        el.querySelectorAll(
            'button, a, label, span, div'
        )
    ).filter(function(child) {
        var childText = (
            child.innerText ||
            child.textContent ||
            ''
        )
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
        return (
            childText.indexOf(wantedClassName) !== -1 &&
            childText.indexOf('(' + targetClass + ')') !== -1
        );
    });
    if (smallerChildren.length > 0) {
        continue;
    }
    matchedClassBox =
        el.closest(
            'button, a, label, [role="button"], [role="radio"]'
        ) || el;
    break;
}
if (!matchedClassBox) {
    diagnosticLogs.push(
        'Class not found yet. Retrying train card...'
    );
    await new Promise(function(r) {
        setTimeout(r, 700);
    });
    attempts++;
    continue;
}
try {
    matchedClassBox.scrollIntoView({
        behavior: 'auto',
        block: 'center'
    });
} catch (e) {}
await new Promise(function(r) {
    setTimeout(r, 150);
});
diagnosticLogs.push(
    'CLICKING REQUESTED CLASS: ' + targetClass
);
try {
    matchedClassBox.click();
    diagnosticLogs.push(
        'CLASS CLICK SENT: ' + targetClass
    );
} catch (classClickError) {
    diagnosticLogs.push(
        'CLASS CLICK FAILED: ' +
        (classClickError.message || classClickError)
    );
    classSelectionCompleted = false;
    attempts++;
    continue;
}
await new Promise(function(r) {
    setTimeout(r, 500);
});
// VERIFY CLASS / AVAILABILITY
var selected = false;
var parentSelected = false;
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
if (!selected && !parentSelected) {
    var selectedElements = Array.from(
        targetCard.querySelectorAll(
            '.active, .selected, [aria-selected="true"], [aria-checked="true"]'
        )
    );
    for (var si = 0; si < selectedElements.length; si++) {
        var selectedText = (
            selectedElements[si].innerText ||
            selectedElements[si].textContent ||
            ''
        )
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
        if (selectedText.indexOf('(' + targetClass + ')') !== -1) {
            parentSelected = true;
            diagnosticLogs.push(
                'Selected state found on class container: ' +
                targetClass
            );
            break;
        }
    }
}
}
// FINAL CLASS STATE RECHECK
if (!selected && !parentSelected) {
    diagnosticLogs.push(
        'Class state not detected yet. Rechecking target class...'
    );
    for (var classRetry = 1; classRetry <= 3; classRetry++) {
        await new Promise(function(r) {
            setTimeout(r, 500);
        });
        var retryNode = matchedClassBox;
        for (
            var retryLevel = 0;
            retryLevel < 5 && retryNode;
            retryLevel++
        ) {
            var retryClass = String(
                retryNode.className || ''
            ).toLowerCase();
            var retryAriaSelected =
                retryNode.getAttribute &&
                retryNode.getAttribute('aria-selected') === 'true';
            var retryAriaChecked =
                retryNode.getAttribute &&
                retryNode.getAttribute('aria-checked') === 'true';
            if (
                retryClass.indexOf('active') !== -1 ||
                retryClass.indexOf('selected') !== -1 ||
                retryAriaSelected ||
                retryAriaChecked
            ) {
                selected = true;
                diagnosticLogs.push(
                    'FINAL RECHECK: ' +
                    targetClass +
                    ' selection confirmed on retry #' +
                    classRetry
                );
                break;
            }
            retryNode = retryNode.parentElement;
        }
        if (selected || parentSelected) {
            break;
        }
    }
}
        // HARD CLASS SELECTION GATE
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
                setTimeout(r, 300);
            });
            attempts++;
            continue;
        }
        // CLASS CONFIRMED
        diagnosticLogs.push(
            "CLASS GATE PASSED: " +
            targetClass +
            " -> Book Now may continue."
        );
        await liveProgress(
    'CLASS CONFIRMED',
    'Class ' + targetClass + ' successfully select ho gayi hain...',
    34
);
        // Availability boxes (AVL/WL/RAC) DOM mein load hone tak wait karein (max 5 sec)
        for (var avlWait = 0; avlWait < 20; avlWait++) {
            var hasAvlLoaded = targetCard && /AVL|WL|RAC|AVAILABLE|NOT AVAILABLE|REGRET/i.test(
                targetCard.innerText || targetCard.textContent || ''
            );
            if (hasAvlLoaded) break;
            await new Promise(function(r) {
                setTimeout(r, 250);
            });
        }
// SAFE JOURNEY DATE CARD SELECTOR
var journeyDateSelected = false;
try {
    // WEB4: Class ke BOOK button par click ho chuka hai.
// Is page par alag journey-date card search mat karo.
var isFirefoxWEB4DateFlow =
    String(payload.browserType || '')
        .trim()
        .toUpperCase() === 'WEB4';
if (isFirefoxWEB4DateFlow && classSelectionCompleted) {
    journeyDateSelected = true;
    diagnosticLogs.push(
        'WEB4: Class BOOK button click ho chuka hai; ' +
        'journey-date card search skip ki ja rahi hai.'
    );
    await liveProgress(
        'CLASS BOOK CLICKED',
        'Selected class ka Book button click ho gaya.',
        38
    );
} else {
await liveProgress(
    'JOURNEY DATE',
    'Journey date select ho rahi hain...',
    36
);
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
    // PARSE JOURNEY DATE
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
    // IMPORTANT:
    // CLASS CLICK KE BAAD TRAIN CARD RE-RENDER HO SAKTA HAI.
    // ISLIYE FRESH TARGET CARD DOBARA FIND KARO.
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
    // FIND EXACT JOURNEY DATE
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
            await liveProgress(
    'DATE CONFIRMED',
    'Journey date successfully select ho gayi hain.',
    38
);
            diagnosticLogs.push(
                "Journey date selected successfully: " +
                targetDay +
                " " +
                targetMonth
            );

            // Read Live Availability & Fare from selected date box & train card DOM
            try {
                if (typeof window.__bossSendAvlFare === 'function') {
                    var boxTxt = (exactDateElement.innerText || exactDateElement.textContent || '').replace(/\s+/g, ' ').trim();
                    var fullCardTxt = (targetCard.innerText || targetCard.textContent || '').replace(/\s+/g, ' ').trim();
                    var avlMatch = boxTxt.match(/\b((?:AVAILABLE|AVL|TQWL|GNWL|RLWL|PQWL|RQWL|RSWL|WL|RAC|REGRET|NOT AVAILABLE)[\s-]*\d*(?:\s*\/\s*(?:WL|RAC)?\s*\d+)?)\b/i);
                    var fareMatch = (boxTxt + ' ' + fullCardTxt).match(/(?:₹|Rs\.?)\s*([\d,]+(?:\.\d{1,2})?)/i);
                    var liveAvl = avlMatch ? avlMatch[1].trim() : 'CHECKED';
                    var liveFare = fareMatch ? '₹' + fareMatch[1].trim() : '--';
                    window.__bossSendAvlFare(liveAvl, liveFare).catch(function() {});
                    diagnosticLogs.push('DOM Live Data -> Avl: ' + liveAvl + ' | Fare: ' + liveFare);
                }
            } catch (_) {}

            await new Promise(function(r) {
                setTimeout(r, 2000);
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
// SAFETY CHECK - JOURNEY DATE MUST BE SELECTED
if (!journeyDateSelected) {
    journeyDateMissingRetries++;
    diagnosticLogs.push(
        'Journey date card visible nahi hua. ' +
        'Fresh train/class retry: ' +
        journeyDateMissingRetries + '/20'
    );
    // Fresh train aur class selection ke liye
    // purani selection state reset karo.
    classSelectionCompleted = false;
    targetCard = null;
    matchedClassBox = null;
    attempts++;
    if (journeyDateMissingRetries >= 20) {
        diagnosticLogs.push(
            'STOP: Journey date missing hone par 20 retries complete.'
        );
        break;
    }
    await new Promise(function(resolve) {
        setTimeout(resolve, 2000);
    });
    continue;
}
// SAFETY CHECK - CLASS MUST BE SELECTED FIRST
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
// WEB4 ka class BOOK click hi booking ko aage le jata hai.
// Passenger form confirm ho chuka hai, isliye purana retry loop skip karo.
if (
    String(payload.browserType || '').trim().toUpperCase() === 'WEB4' &&
    bookNowClicked
) {
    diagnosticLogs.push(
        'WEB4: Passenger form ready; skipping old Book Now retry loop.'
    );
    break;
}
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
        // Retry window
        //
        // Tatkal:
        //  60 attempts x 1 sec
        //
        // General:
        //  30 attempts x 1 sec
        //
        // Isse temporary disabled/not-ready state mein
        // task immediately fail nahi hoga.
        var bookRetryLimit =
            isTatkal ? 60 : 30;
            // IRCTC explicit BOOK error retry limit
var bookNowErrorRetryCount = 0;
var bookNowErrorRetryLimit = 20;
// PERMANENT PASSENGER PAGE DETECTOR
// WEB / WEB2 / WEB3
var passengerPageReached = false;
var passengerPageObserver = null;
var checkPassengerPage = function() {
    if (passengerPageReached) return true;
    var currentUrl = window.location.href.toLowerCase();
    var passengerInput = document.querySelector(
        'input[formcontrolname="passengerName"], ' +
        'input[placeholder*="Full Name"], ' +
        'input[placeholder*="Govt"]'
    );
    if (
        currentUrl.indexOf('psgninput') !== -1 ||
        passengerInput
    ) {
        passengerPageReached = true;
        bookNowClicked = true;
        diagnosticLogs.push(
            "PASSENGER PAGE DETECTED! All Book Now retries stopped."
        );
        if (passengerPageObserver) {
            passengerPageObserver.disconnect();
        }
        return true;
    }
    return false;
};
passengerPageObserver = new MutationObserver(function() {
    checkPassengerPage();
});
passengerPageObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true
});
window.addEventListener('popstate', checkPassengerPage);
window.addEventListener('hashchange', checkPassengerPage);
// Immediately check current page
checkPassengerPage();
        for (
    var bTry = 0;
    bTry < bookRetryLimit && !passengerPageReached;
    bTry++
) {
    if (checkPassengerPage()) {
        break;
    }
        // FRESH TARGET CARD (STRICT & SAFE TRAIN ROW FINDER)
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
        await new Promise(function(r) { setTimeout(r, 150); });
        continue;
    }
retryClassEl.click();
await new Promise(function(r) { setTimeout(r, 300); });
targetCard = Array.from(
    document.querySelectorAll(
        'p-accordionTab, div.train-avl-col, div.form-group'
    )
).find(function(el) {
    if (!el || !el.isConnected) {
        return false;
    }
    var text = (
        el.innerText ||
        el.textContent ||
        ''
    );
    if (
        text.indexOf(
            String(payload.targetTrainNo)
        ) === -1
    ) {
        return false;
    }
    var nestedCards = el.querySelectorAll(
        'p-accordionTab, div.train-avl-col'
    );
    return nestedCards.length === 0;
}) || null;
// SAFETY CHECK - RETRY TARGET CARD
if (!targetCard) {
    diagnosticLogs.push(
        "Retry: Target train card DOM mein temporarily available nahi hai. Waiting before next retry..."
    );
    await new Promise(function(r) {
        setTimeout(r, 300);
    });
    continue;
}
// JOURNEY DATE
var retryDateEl = Array.from(
    targetCard.querySelectorAll(
        'div,td,span,button,a'
    )
)
.sort(function(a, b) {
    return (
        a.querySelectorAll('*').length -
        b.querySelectorAll('*').length
    );
})
.find(function(el) {
    var t = (
        el.innerText ||
        el.textContent ||
        ''
    )
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
    return (
        t.indexOf(
            (
                targetDay +
                ' ' +
                targetMonth
            ).toUpperCase()
        ) !== -1
    ) &&
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
        await new Promise(function(r) { setTimeout(r, 150); });
        continue;
    }
    retryDateEl.click();
    diagnosticLogs.push(
        "Retry: Train -> Class -> Journey Date selected."
    );
    await new Promise(function(r) { setTimeout(r, 200); });
}
            // Find Book Now (WEB4 Beta + Other Browsers)
            var bookBtn = null;
            var isFirefoxWEB4 =
                String(payload.browserType || '')
                    .trim()
                    .toUpperCase() === 'WEB4';
            if (isFirefoxWEB4 && targetCard) {
                var betaWantedClass = String(
                    payload.trainClass || ''
                ).trim().toUpperCase();
                var betaClassNames = {
                    'SL': 'SLEEPER',
                    '3E': 'AC 3 ECONOMY',
                    '3A': 'AC 3 TIER',
                    '2A': 'AC 2 TIER',
                    '1A': 'AC FIRST CLASS'
                };
                var betaWantedName =
                    betaClassNames[betaWantedClass] ||
                    betaWantedClass;
                var betaClassCard = Array.from(
                    targetCard.querySelectorAll('.class-card')
                ).find(function(card) {
                    var code = card.querySelector('.class-code');
                    var text = (
                        code
                            ? (code.innerText || code.textContent || '')
                            : ''
                    ).replace(/\s+/g, ' ').trim().toUpperCase();
                    return text ===
                        betaWantedName + ' (' + betaWantedClass + ')';
                });
                if (betaClassCard) {
                    bookBtn = betaClassCard.querySelector('button.btn-book');
                    diagnosticLogs.push(
                        bookBtn
                            ? 'WEB4 Beta: Target class ka BOOK button mila.'
                            : 'WEB4 Beta: Target class card mila, BOOK button nahi mila.'
                    );
                } else {
                    diagnosticLogs.push(
                        'WEB4 Beta: Target class card nahi mila: ' +
                        betaWantedClass
                    );
                }
            } else if (targetCard) {
                // Existing Chrome / Edge / Brave logic unchanged
                bookBtn = Array.from(
                    targetCard.querySelectorAll('button, a')
                ).find(function(b) {
                    var t = (
                        b.innerText ||
                        b.textContent ||
                        ''
                    ).trim().toUpperCase();
                    return t.indexOf('BOOK NOW') !== -1;
                });
            }
            // Check disabled
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
                if (checkPassengerPage()) {
    break;
}
diagnosticLogs.push(
    "Attempt " +
    (bTry + 1) +
    ": Clicking Book Now..."
);
try {
    if (checkPassengerPage()) {
        break;
    }
    bookBtn.click();
await liveProgress(
    'BOOK NOW',
    'BOOKING START KAR RAHE HAIN...',
    45
);
diagnosticLogs.push(
    "Book Now click sent. Passenger page load hone ka wait..."
);
var bookNowErrorFound = false;
while (!passengerPageReached && !bookNowErrorFound) {
    await new Promise(function(r) {
        setTimeout(r, 250);
    });
    if (checkPassengerPage()) {
    break;
}
    // Passenger page detection
    var passengerNameInput = document.querySelector(
        'input[formcontrolname="passengerName"], ' +
        'input[placeholder*="Full Name"], ' +
        'input[placeholder*="Govt"]'
    );
    var isPassengerUrl =
        window.location.href.toLowerCase().indexOf('psgninput') !== -1;
    if (isPassengerUrl || passengerNameInput) {
        passengerPageReached = true;
        diagnosticLogs.push(
            "Passenger page detected after Book Now."
        );
        break;
    }
    // Explicit IRCTC toast detection
    var bookToastMessages = Array.from(
        document.querySelectorAll('.ui-toast-detail')
    ).map(function(el) {
        return (
            el.innerText ||
            el.textContent ||
            ''
        ).replace(/\s+/g, ' ').trim();
    });
    var bookToastError = bookToastMessages.find(function(message) {
        return /high load|unable to process(?: the)? request|please retry/i.test(message);
    }) || '';
    // Page text fallback
    var currentBookPageText = (
        document.body.innerText ||
        document.body.textContent ||
        ''
    );
    bookNowErrorFound = !!bookToastError ||
        /high load|unable to process(?: the)? request|please retry/i.test(
            currentBookPageText
        );
    if (bookNowErrorFound) {
        diagnosticLogs.push(
            "IRCTC BOOK error detected: " +
            (bookToastError || "High Load / Unable to Process Request")
        );
        // Close only the matching error toast
        var errorToast = Array.from(
            document.querySelectorAll('.ui-toast')
        ).find(function(toast) {
            return /high load|unable to process(?: the)? request|please retry/i.test(
                toast.innerText || toast.textContent || ''
            );
        });
        if (errorToast) {
            var closeButton = errorToast.querySelector(
                'a.ui-toast-close-icon, button'
            );
            if (closeButton) {
                closeButton.click();
            }
        }
        break;
    }
}
// Passenger page success
if (passengerPageReached) {
    bookNowClicked = true;
    await liveProgress(
        'PASSENGER PAGE',
        'FILLING PASSENGER DETAILS...',
        50
    );
    diagnosticLogs.push(
        "Passenger page reached. Book Now retry stopped."
    );
    break;
}
// Retry only on confirmed IRCTC error
if (bookNowErrorFound) {
    bookNowErrorRetryCount++;
    diagnosticLogs.push(
        "BOOK error retry " +
        bookNowErrorRetryCount +
        "/" +
        bookNowErrorRetryLimit
    );
    if (bookNowErrorRetryCount >= bookNowErrorRetryLimit) {
        diagnosticLogs.push(
            "Maximum confirmed BOOK error retries reached. Stopping safely."
        );
        break;
    }
// RECOVERY SAFETY CHECK 1:
// INSTANT PASSENGER PAGE DETECTION
if (checkPassengerPage()) {
    bookNowClicked = true;
    diagnosticLogs.push(
        "Passenger page detected during recovery. Stopping all Book Now retries."
    );
    await liveProgress(
        'PASSENGER PAGE',
        'FILLING PASSENGER DETAILS...',
        50
    );
    break;
}
// RECOVERY SAFETY CHECK 2: REFIND EXACT TRAIN CARD
var recoveryTargetCard = Array.from(
    document.querySelectorAll(
        'p-accordionTab, div.train-avl-col, div.form-group'
    )
).find(function(card) {
    if (!card || !card.isConnected) {
        return false;
    }
    var cardText = (
        card.innerText ||
        card.textContent ||
        ''
    );
    if (
        cardText.indexOf(
            String(payload.targetTrainNo)
        ) === -1
    ) {
        return false;
    }
    var nestedCards = card.querySelectorAll(
        'p-accordionTab, div.train-avl-col'
    );
    return nestedCards.length === 0;
});
if (!recoveryTargetCard) {
    diagnosticLogs.push(
        "Recovery: Exact target train card not found. Skipping retry."
    );
    continue;
}
// RECOVERY SAFETY CHECK 3: REFIND BOOK NOW BUTTON
// AND VERIFY IT IS NOT DISABLED
var recoveryBookBtn = null;
if (
    String(payload.browserType || '')
        .trim()
        .toUpperCase() === 'WEB4'
) {
    var recoveryClass = String(
        payload.trainClass || ''
    ).trim().toUpperCase();
    var recoveryClassNames = {
        'SL': 'SLEEPER',
        '3E': 'AC 3 ECONOMY',
        '3A': 'AC 3 TIER',
        '2A': 'AC 2 TIER',
        '1A': 'AC FIRST CLASS'
    };
    var recoveryWantedName =
        recoveryClassNames[recoveryClass] ||
        recoveryClass;
    var recoveryClassCard = Array.from(
        recoveryTargetCard.querySelectorAll('.class-card')
    ).find(function(card) {
        var code = card.querySelector('.class-code');
        var text = (
            code
                ? (code.innerText || code.textContent || '')
                : ''
        ).replace(/\s+/g, ' ').trim().toUpperCase();
        return text ===
            recoveryWantedName + ' (' + recoveryClass + ')';
    });
    if (recoveryClassCard) {
        recoveryBookBtn =
            recoveryClassCard.querySelector('button.btn-book');
    }
} else {
    recoveryBookBtn = Array.from(
        recoveryTargetCard.querySelectorAll('button, a')
    ).find(function(btn) {
        var text = (
            btn.innerText ||
            btn.textContent ||
            ''
        ).trim().toUpperCase();
        return text.indexOf('BOOK NOW') !== -1;
    });
}
var recoveryBtnDisabled =
    recoveryBookBtn &&
    (
        recoveryBookBtn.disabled ||
        recoveryBookBtn.getAttribute('disabled') !== null ||
        recoveryBookBtn.getAttribute('aria-disabled') === 'true' ||
        recoveryBookBtn.classList.contains('disabled')
    );
if (!recoveryBookBtn) {
    diagnosticLogs.push(
        "Recovery: Book Now button not found. Skipping retry."
    );
    continue;
}
if (recoveryBtnDisabled) {
    diagnosticLogs.push(
        "Recovery: Book Now button is disabled. Skipping retry."
    );
    continue;
}
diagnosticLogs.push(
    "Recovery safety checks passed: Passenger page, target train and enabled Book Now verified."
);
// EXISTING NEW RETRY FLOW - KEEP UNCHANGED
if (checkPassengerPage()) {
    bookNowClicked = true;
    await liveProgress(
        'PASSENGER PAGE',
        'FILLING PASSENGER DETAILS...',
        50
    );
    break;
}
classSelectionCompleted = false;
targetCard = null;
continue;
}
// No passenger page and no confirmed error:
// Do not click BOOK again blindly.
diagnosticLogs.push(
    "Passenger page not detected and no confirmed IRCTC error. " +
    "Stopping retry to avoid duplicate BOOK click."
);
break;
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
            // IMPORTANT:
            // 3000ms wait between retries
            await new Promise(function(r) {
                setTimeout(r, 3000);
            });
        }
        // BOOK NOW SUCCESS
        if (bookNowClicked) {
            diagnosticLogs.push(
                "Book Now process completed successfully."
            );
            break;
        }
        // Retry window finished
        diagnosticLogs.push(
            "Book Now retry window finished for current train card."
        );
    } else {
        // TRAIN CARD NOT FOUND YET
        diagnosticLogs.push(
            "Target train not found yet. Waiting for train list..."
        );
        await new Promise(function(r) {
            setTimeout(r, 400);
        });
    }
    attempts++;
    await new Promise(function(r) {
        setTimeout(r, 500);
    });
}
// FINAL BOOK NOW RESULT
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
var isFirefoxWEB4 =
    String(payload.browserType || '').toUpperCase() === 'WEB4';
var navSuccess = false;
var nameInputs = [];
if (isFirefoxWEB4) {
    // WEB4: pehle passenger page ka wait karo
    diagnosticLogs.push("WEB4: Waiting for passenger page...");
    for (var w = 0; w < 60; w++) {
        await new Promise(function(resolve) {
            setTimeout(resolve, 500);
        });
        if (window.location.href.indexOf('psgninput') !== -1) {
            navSuccess = true;
            break;
        }
    }
    if (!navSuccess) {
        return {
            success: false,
            error: 'WEB4: Passenger page nahi mila.',
            logs: diagnosticLogs
        };
    }
    diagnosticLogs.push("WEB4: Passenger page opened.");
    // Exact New Passenger button click karo
    var newPassengerBtn = document.querySelector(
        'button.btn.btn-new-passenger'
    );
    if (newPassengerBtn) {
        newPassengerBtn.click();
        diagnosticLogs.push("WEB4: New Passenger button clicked.");
    } else {
        return {
            success: false,
            error: 'WEB4: New Passenger button nahi mila.',
            logs: diagnosticLogs
        };
    }
    // Form ke inputs ka wait karo
    for (var f = 0; f < 40; f++) {
        await new Promise(function(resolve) {
            setTimeout(resolve, 250);
        });
        nameInputs = Array.from(
            document.querySelectorAll(
                'input[formcontrolname="passengerName"], input[placeholder*="Full Name"], input[placeholder*="Govt"]'
            )
        );
        if (nameInputs.length > 0) {
            break;
        }
    }
    navSuccess = nameInputs.length > 0;
} else {
    // WEB / WEB2 / WEB3: existing logic
    while (true) {
        await new Promise(function(resolve) {
            setTimeout(resolve, 500);
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
}
if (!navSuccess || nameInputs.length === 0) {
    return {
        success: false,
        error: 'Passenger page/form load nahi hua.',
        logs: diagnosticLogs
    };
}
diagnosticLogs.push("Passenger page + form ready.");
await liveProgress(
    'PASSENGER DETAILS',
    'FILLING PASSENGER DETAILS....',
    60
);
diagnosticLogs.push(
    "Filling passenger details using native setters & PrimeNG handlers..."
);
 var passengers = payload.passengers || [];
 if (passengers.length === 0) {
     passengers = [{ name: "Passenger 1", age: 30, gender: "M" }];
 }
 for (var i = 0; i < passengers.length; i++) {
     var p = passengers[i];
     // 1. Agar pehla passenger nahi hai, toh "Add Passenger" button par click karein taaki naya row aaye
// WEB4: Har agle passenger ke liye New Passenger click karo
if (i > 0) {
    if (
        String(payload.browserType || '').trim().toUpperCase() === 'WEB4'
    ) {
        var web4NewPassengerBtn = Array.from(
            document.querySelectorAll('button, a, span')
        ).find(function (el) {
            var txt = (
                el.innerText ||
                el.textContent ||
                ''
            ).replace(/\s+/g, ' ').trim().toLowerCase();
            return (
                txt === 'new passenger' &&
                el.getClientRects().length > 0
            );
        });
        if (web4NewPassengerBtn) {
            web4NewPassengerBtn.click();
            diagnosticLogs.push(
                'WEB4: New Passenger clicked for passenger ' +
                (i + 1)
            );
            await new Promise(function (resolve) {
                setTimeout(resolve, 400);
            });
        } else {
            diagnosticLogs.push(
                'WEB4 ERROR: New Passenger button nahi mila, passenger ' +
                (i + 1)
            );
            break;
        }
    } else {
        // Baaki browsers ka existing code
        var addBtn = document.querySelector(
            'span.add-passenger, a.add-passenger, ' +
            'span.fa-plus-circle, button[label*="Add Passenger"]'
        );
        if (!addBtn) {
            var clickableElements =
                document.querySelectorAll('span, a, button');
            for (var ce = 0; ce < clickableElements.length; ce++) {
                var txt = (
                    clickableElements[ce].innerText || ''
                ).trim().toLowerCase();
                if (
                    txt === 'add passenger' ||
                    txt.indexOf('add passenger') !== -1
                ) {
                    addBtn = clickableElements[ce];
                    break;
                }
            }
        }
        if (addBtn) {
            addBtn.click();
            diagnosticLogs.push(
                "Clicked 'Add Passenger' for row " + (i + 1)
            );
            await new Promise(function (resolve) {
                setTimeout(resolve, 600);
            });
        } else {
            diagnosticLogs.push(
                "Warning: 'Add Passenger' button nahi mila."
            );
        }
    }
}
    // Har iteration par sirf visible fresh inputs query karein taaki naye rows detect ho sakein
     var nameInputs = Array.from(
         document.querySelectorAll('input[formcontrolname="passengerName"], input[placeholder*="Full Name"], input[placeholder*="Govt"]')
     ).filter(function(el) { return el.offsetParent !== null; });

     var ageInputs = Array.from(
         document.querySelectorAll('input[formcontrolname="passengerAge"], input[placeholder*="Age"]')
     ).filter(function(el) { return el.offsetParent !== null; });

     var genderControls = Array.from(
         document.querySelectorAll('select[formcontrolname="passengerGender"]')
     ).filter(function(el) { return el.offsetParent !== null; });

    
// NAME + AGE: Fill complete values together
var passengerIndex =
    String(payload.browserType || '').trim().toUpperCase() === 'WEB4'
        ? 0
        : i;

var nameInput = nameInputs[passengerIndex];
var ageInput = ageInputs[passengerIndex];

var nameToFill = String(
    p.name || p.passengerName || 'Test Passenger'
);

var ageToFill = String(
    p.age || p.passengerAge || 30
);

if (nameInput && ageInput) {
    var inputSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
    ).set;

    nameInput.focus();
    inputSetter.call(nameInput, nameToFill);
    nameInput.dispatchEvent(
        new Event('input', { bubbles: true })
    );
    nameInput.dispatchEvent(
        new Event('change', { bubbles: true })
    );
    nameInput.blur();

    ageInput.focus();
    inputSetter.call(ageInput, ageToFill);
    ageInput.dispatchEvent(
        new Event('input', { bubbles: true })
    );
    ageInput.dispatchEvent(
        new Event('change', { bubbles: true })
    );
    ageInput.blur();

    diagnosticLogs.push(
        'Passenger ' + (i + 1) +
        ' Name and Age filled together.'
    );

    await new Promise(function(resolve) {
        setTimeout(resolve, 400);
    });
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
    // FIND NATIVE SELECT
  var genderSelect = null;
var isFirefoxWEB4Gender =
    String(payload.browserType || '')
        .trim()
        .toUpperCase() === 'WEB4';
if (isFirefoxWEB4Gender) {
    var web4GenderDropdowns = document.querySelectorAll(
        'p-dropdown[formcontrolname="passengerGender"]'
    );
    var web4GenderDropdown = web4GenderDropdowns[0];
    if (web4GenderDropdown) {
        diagnosticLogs.push(
            'WEB4: Custom gender dropdown found for passenger ' +
            (i + 1)
        );
    } else {
        diagnosticLogs.push(
            'WEB4 ERROR: Custom gender dropdown nahi mila.'
        );
    }
} else {
    // Baaki browsers ka existing native SELECT code
    var genderControls = document.querySelectorAll(
        'select[formcontrolname="passengerGender"]'
    );
    if (genderControls.length > i) {
        genderSelect = genderControls[i];
        diagnosticLogs.push(
            "Gender SELECT found using passengerGender"
        );
    }
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
    // SELECT NOT FOUND
    // WEB4 ONLY: PrimeNG custom Gender dropdown
if (
    String(payload.browserType || '').trim().toUpperCase() === 'WEB4'
) {
    var web4GenderDropdowns = document.querySelectorAll(
        'p-dropdown[formcontrolname="passengerGender"]'
    );
    var web4GenderDropdown = web4GenderDropdowns[0];
    var web4GenderLabel = wantedGender === 'F'
        ? 'Female'
        : wantedGender === 'T'
            ? 'Transgender'
            : 'Male';
    if (!web4GenderDropdown) {
        diagnosticLogs.push(
            'WEB4 ERROR: Gender dropdown nahi mila passenger ' +
            (i + 1)
        );
    } else {
        web4GenderDropdown.scrollIntoView({
            behavior: 'auto',
            block: 'center'
        });
        await new Promise(function (resolve) {
            setTimeout(resolve, 200);
        });
        var web4CurrentLabel = web4GenderDropdown.querySelector(
            '.ui-dropdown-label'
        );
        var web4CurrentText = web4CurrentLabel
            ? (web4CurrentLabel.innerText || '').trim()
            : '';
        if (web4CurrentText.toUpperCase() !== web4GenderLabel.toUpperCase()) {
            var web4DropdownTrigger = web4GenderDropdown.querySelector(
                '.ui-dropdown-trigger'
            );
            if (web4DropdownTrigger) {
                web4DropdownTrigger.click();
            }
            await new Promise(function (resolve) {
                setTimeout(resolve, 300);
            });
            var web4GenderOptions = Array.from(
                document.querySelectorAll(
                    '.ui-dropdown-panel li[role="option"], .p-dropdown-panel li[role="option"], li[role="option"]'
                )
            ).filter(function(opt) {
                return opt.getClientRects().length > 0;
            });

            var web4WantedOption = web4GenderOptions.find(
                function (option) {
                    var optionText = (
                        option.getAttribute('aria-label') ||
                        option.innerText ||
                        option.textContent ||
                        ''
                    ).trim().toUpperCase();
                    return optionText === web4GenderLabel.toUpperCase();
                }
            );
            if (web4WantedOption) {
                web4WantedOption.click();
                await new Promise(function (resolve) {
                    setTimeout(resolve, 350);
                });
                var web4VerifyLabel = web4GenderDropdown.querySelector(
                    '.ui-dropdown-label'
                );
                var web4VerifyText = web4VerifyLabel
                    ? (web4VerifyLabel.innerText || '').trim()
                    : '';
                diagnosticLogs.push(
                    'WEB4 Gender result passenger ' + (i + 1) +
                    ': requested=' + web4GenderLabel +
                    ' | selected=' + web4VerifyText
                );
               if (
    web4VerifyText.toUpperCase() ===
    web4GenderLabel.toUpperCase()
) {
    diagnosticLogs.push(
        'WEB4: Gender verified. Add button click kar rahe hain.'
    );
    await new Promise(function (resolve) {
        setTimeout(resolve, 250);
    });
    var web4AddButton = Array.from(
        document.querySelectorAll('button.ap-add-btn')
    ).find(function (button) {
        return (
            (button.innerText || button.textContent || '')
                .trim()
                .toUpperCase() === 'ADD' &&
            !button.disabled &&
            button.getClientRects().length > 0
        );
    });
    if (web4AddButton) {
        web4AddButton.scrollIntoView({
            behavior: 'auto',
            block: 'center'
        });
        web4AddButton.click();
        diagnosticLogs.push(
            'WEB4: Add button clicked after gender selection.'
        );
    } else {
        diagnosticLogs.push(
            'WEB4 ERROR: Visible enabled Add button nahi mila.'
        );
    }
} else {
    diagnosticLogs.push(
        'WEB4 ERROR: Gender verify nahi hua; Add button click nahi kiya.'
    );
}
            } else {
                diagnosticLogs.push(
                    'WEB4 ERROR: Option nahi mila: ' +
                    web4GenderLabel
                );
            }
        } else {
            diagnosticLogs.push(
                'WEB4: Gender pehle se selected hai: ' +
                web4CurrentText
            );
        }
    }
} else if (!genderSelect) {
        // Fallback: Check agar WEB/WEB2/WEB3 mein PrimeNG <p-dropdown> use hua hai
        var primeGenderDropdowns = Array.from(
            document.querySelectorAll('p-dropdown[formcontrolname="passengerGender"]')
        ).filter(function(el) { return el.offsetParent !== null; });

        var primeGenderDropdown = primeGenderDropdowns[i] || primeGenderDropdowns[primeGenderDropdowns.length - 1];

        if (primeGenderDropdown) {
            diagnosticLogs.push("PrimeNG gender dropdown found for passenger " + (i + 1));
            var trigger = primeGenderDropdown.querySelector('.ui-dropdown-trigger, .p-dropdown-trigger') || primeGenderDropdown;
            trigger.click();
            await new Promise(function(r) { setTimeout(r, Math.floor(Math.random() * 100) + 150); }); // Human-like dropdown open delay

            var wantedLabel = wantedGender === 'F' ? 'FEMALE' : wantedGender === 'T' ? 'TRANSGENDER' : 'MALE';
            var primeOptions = Array.from(
                document.querySelectorAll('.ui-dropdown-panel li, .p-dropdown-panel li, li[role="option"]')
            ).filter(function(opt) { return opt.getClientRects().length > 0; });

            var matchedPrimeOpt = primeOptions.find(function(opt) {
                var txt = (opt.innerText || opt.textContent || '').trim().toUpperCase();
                return txt === wantedLabel || txt === wantedGender;
            });

            if (matchedPrimeOpt) {
                await new Promise(function(r) { setTimeout(r, Math.floor(Math.random() * 100) + 100); });
                matchedPrimeOpt.click();
                await new Promise(function(r) { setTimeout(r, Math.floor(Math.random() * 100) + 150); });
                diagnosticLogs.push("PrimeNG Gender selected: " + wantedLabel + " for passenger " + (i + 1));
            } else {
                diagnosticLogs.push("ERROR: PrimeNG gender option nahi mili for passenger " + (i + 1));
            }
        } else {
            diagnosticLogs.push(
                "ERROR: Native gender SELECT aur PrimeNG dropdown dono nahi mile passenger " +
                (i + 1)
            );
        }
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
            setTimeout(resolve, 150);
        });
        // INSPECT OPTIONS
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
        // SET VALUE
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
                setTimeout(resolve, 100);
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
    setTimeout(resolve, 100);
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
    await new Promise(function(r) { setTimeout(r, 100); });
 
    // Mobile Number - Fill complete number at once
    var mobStr = String(mobileVal);

    nativeMobileSetter.call(mobileInput, mobStr);

    mobileInput.dispatchEvent(
        new Event("input", { bubbles: true })
    );

    mobileInput.dispatchEvent(
        new Event("change", { bubbles: true })
    );

    mobileInput.dispatchEvent(
        new Event("blur", { bubbles: true })
    );

    if (mobileInput.value === mobStr && mobStr.length > 0) {
        mobileFilled = true;
        diagnosticLogs.push("Mobile number filled successfully.");
    } else {
        diagnosticLogs.push("Mobile number set nahi hua.");
    }

} catch (mErr) {
    diagnosticLogs.push("Mobile error: " + mErr.message);
}

await new Promise(function(r) {
    setTimeout(r, 300);
});

// BOOK ONLY IF CONFIRMED BERTH - AUTO TICK
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
        await new Promise(function(r) {
    setTimeout(r, 100);
});
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
                await new Promise(function(r) {
    setTimeout(r, 150);
});
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
            await new Promise(function(r) { setTimeout(r, 100); });
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
await new Promise(function(r) { setTimeout(r, 2000); });

// CHECK IF IRCTC LOGGED OUT (10:00 AM AC & 11:00 AM NON-AC TATKAL)
var loginModalOpen = document.querySelector('input[formcontrolname="userid"]');
var pageBodyUpper = (document.body.innerText || '').toUpperCase();
var currentHour = new Date().getHours();
var tatkalSlot = currentHour === 10 ? '10:00 AM (AC)' : currentHour === 11 ? '11:00 AM (Non-AC)' : 'Tatkal';

if (loginModalOpen || (pageBodyUpper.includes('LOGIN') && !pageBodyUpper.includes('LOGOUT') && !isFirefoxWEB4)) {
    return {
        success: false,
        error: 'IRCTC Session Logged Out at ' + tatkalSlot + ' time! (Ek hi ID 2 jagah login thi ya session expire hua).',
        logs: diagnosticLogs
    };
}

// FIRST CONTINUE / WEB4 CALCULATE FARE
var isFirefoxWEB4PaymentCalculateFare =
    String(payload.browserType || '')
        .trim()
        .toUpperCase() === 'WEB4';
if (isFirefoxWEB4PaymentCalculateFare) {
    
    // WEB4 ONLY: Calculate Fare button wait
    var calculateFareBtn = null;
    var web4FareRetrySuccess = false;
    var fareTry = 0;
    while (!web4FareRetrySuccess) {
       
        // Button ko maximum 30 seconds search karo
        calculateFareBtn = null;
        for (var fareButtonWait = 0; fareButtonWait < 60; fareButtonWait++) {
            calculateFareBtn = Array.from(
                document.querySelectorAll('button.btn-calc-fare')
            ).find(function(b) {
                var text = (b.innerText || b.textContent || '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .toLowerCase();
                return text.includes('calculate fare') &&
                    b.getClientRects().length > 0 &&
                    !b.disabled;
            });
            if (calculateFareBtn) break;
            await new Promise(function(resolve) {
                setTimeout(resolve, 500);
            });
        }
        if (!calculateFareBtn) {
            return {
                success: false,
                error: 'WEB4: Calculate Fare button nahi mila ya enabled nahi hua.',
                logs: diagnosticLogs
            };
        }
        
        // Button ko fresh locate karke click karo
        calculateFareBtn.scrollIntoView({
            behavior: 'instant',
            block: 'center'
        });
        await new Promise(function(resolve) {
            setTimeout(resolve, 500);
        });
       
        // Recheck button
        calculateFareBtn = Array.from(
            document.querySelectorAll('button.btn-calc-fare')
        ).find(function(b) {
            var text = (b.innerText || b.textContent || '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
            return text.includes('calculate fare') &&
                b.getClientRects().length > 0 &&
                !b.disabled;
        });
        if (!calculateFareBtn) continue;
        fareTry++;
        diagnosticLogs.push(
            'WEB4: Calculate Fare actual click attempt ' + fareTry
        );
        calculateFareBtn.click();
        
        // Click ke baad response ka wait
        var fareResponseDetected = false;
        for (var fareWait = 0; fareWait < 360; fareWait++) {
            await new Promise(function(resolve) {
                setTimeout(resolve, 500);
            });
        
        // Button dobara visible hai ya nahi
            var currentFareButton = Array.from(
                document.querySelectorAll('button.btn-calc-fare')
            ).find(function(b) {
                return b.getClientRects().length > 0 &&
                    !b.disabled;
            });
            
            // Review text ke saath button ka disappear hona bhi verify karo
            var currentFareText = document.body.innerText || '';
            var reviewDetected =
                /\bbooking\s+review\b/i.test(currentFareText);
            if (reviewDetected && !currentFareButton) {
                web4FareRetrySuccess = true;
                fareResponseDetected = true;
                diagnosticLogs.push(
                    'WEB4: Calculate Fare click verified. Review page confirmed.'
                );
                break;
            }
            
            // IRCTC error toast
            var fareToastError = getWEB4ToastError();
            if (fareToastError) {
                diagnosticLogs.push(
                    'WEB4 Calculate Fare error: ' + fareToastError
                );
                var fareErrorClose = document.querySelector(
                    'a.ui-toast-close-icon.pi.pi-times'
                );
                if (fareErrorClose) {
                    fareErrorClose.click();
                }
                await new Promise(function(resolve) {
                    setTimeout(resolve, 2000);
                });
                fareResponseDetected = true;
                break;
            }
        }
        if (web4FareRetrySuccess) break;
        if (!fareResponseDetected) {
            return {
                success: false,
                error: 'WEB4: Calculate Fare click ke baad 180 seconds tak page response nahi mila.',
                logs: diagnosticLogs
            };
        }
        diagnosticLogs.push(
            'WEB4: Calculate Fare dobara attempt kiya jayega.'
        );
    }
} else {
   
    // Verify karein ki BHIM/UPI PrimeNG radio box actually checked hai
    var anyPaymentChecked = Array.from(
        document.querySelectorAll('input[type="radio"]')
    ).some(function(r) { return r.checked; });

    if (!anyPaymentChecked) {
        diagnosticLogs.push('WARNING: Payment radio checked nahi hai, PrimeNG BHIM/UPI box click kar rahe hain...');
        var fallbackUpi = Array.from(document.querySelectorAll('p-radiobutton')).find(function(el) {
            var txt = (el.innerText || '').toUpperCase();
            return txt.includes('BHIM/UPI') && !txt.includes('UPI_CC');
        });
        if (fallbackUpi) {
            var radioBox = fallbackUpi.querySelector('.ui-radiobutton-box, .p-radiobutton-box') || fallbackUpi;
            radioBox.click();
            await new Promise(function(r) { setTimeout(r, 600); });
        }
    }

    // WEB / WEB2 / WEB3: PURANA LOGIC SAME
    var continueBtn1 = Array.from(
        document.querySelectorAll('button')
    ).find(function (b) {
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
    await new Promise(function (r) {
        setTimeout(r, 500);
    });
    
    // Button ko fresh DOM se dobara locate karo
    continueBtn1 = Array.from(
        document.querySelectorAll('button')
    ).find(function (b) {
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
            error: 'First continue button 500ms state wait ke baad nahi mila.',
            logs: diagnosticLogs
        };
    }
    continueBtn1.click();
    diagnosticLogs.push(
        'First Continue button clicked after 500ms state-settling wait.'
    );
    diagnosticLogs.push(
        'First Continue button clicked.'
    );
}

// HELPER: EXACT IRCTC ERROR FOR MINI WINDOW
function getIRCTCErrorStatus(text) {
    var lowerText = String(text || '').toLowerCase();
    if (lowerText.includes('high load')) {
        return {
            step: 'HIGH LOAD',
            message: 'HIGH LOAD'
        };
    }
    if (
        lowerText.includes('unable to process request') ||
        lowerText.includes('unable to process the request') ||
        lowerText.includes('unable to process')
    ) {
        return {
            step: 'UNABLE TO PROCESS REQUEST',
            message: 'unable to process request'
        };
    }
    if (lowerText.includes('please retry')) {
        return {
            step: 'PLEASE RETRY',
            message: 'please retry'
        };
    }
    return {
        step: 'BOOKING ERROR',
        message: 'IRCTC booking error'
    };
}

// OLD SITE ONLY - FIRST CONTINUE RETRY
// WEB4 ko is loop se bahar rakho
if (!isFirefoxWEB4PaymentCalculateFare) {

    // FIRST CONTINUE RETRY
var firstRetry = 0;
var firstRetryLimit = 20;
var firstWaitCycles = 0;
var firstWaitCycleLimit = 360;
var previousPopup = false;
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
    var isNewPopup = !previousPopup;
    previousPopup = true;
    
    // Same popup ko baar-baar count mat karo
    if (!isNewPopup) {
        continue;
    }
    firstRetry++;
    diagnosticLogs.push(
        "First Continue error popup. Retry " +
        firstRetry + "/" + firstRetryLimit
    );
    var detectedError = getIRCTCErrorStatus(
        document.body.innerText || ''
    );
    await liveProgress(
        detectedError.step,
        detectedError.message,
        20
    );
    var close = document.querySelector(
        'a.ui-toast-close-icon.pi.pi-times, .ui-toast button'
    );
    if (close) {
        try {
            close.click();
            diagnosticLogs.push(
                "First Continue error toast closed. Waiting 2 seconds before retry..."
            );
        } catch (e) {}
    }
    // Exactly 2 seconds wait before next continue attempt
    await new Promise(function(r) {
        setTimeout(r, 2000);
    });
    
    // 20 retries allow karo
    if (firstRetry > firstRetryLimit) {
        return {
            success: false,
            error: 'First Continue failed after 20 retries.',
            logs: diagnosticLogs
        };
    }
    
    // Fresh Continue button
    continueBtn1 = Array.from(
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
    if (continueBtn1) {
        await new Promise(function(r) {
            setTimeout(r, 500);
        });
        if (
            continueBtn1.offsetParent !== null &&
            !continueBtn1.disabled
        ) {
            continueBtn1.click();
            diagnosticLogs.push(
                "First Continue retry clicked."
            );
        }
    }
    continue;
}
    previousPopup = false;
    var currentPageText =
        (document.body && document.body.innerText || '')
            .replace(/\s+/g, ' ')
            .toLowerCase();
    
            // Review Journey page ki exact detection
    var reviewPage =
        currentPageText.includes('review journey') ||
        currentPageText.includes('review your journey');
    
        // Loader abhi bhi visible hai?
    var wait =
        currentPageText.includes('please wait') ||
        currentPageText.includes('processing') ||
        currentPageText.includes('loading');
    
        // Sirf Review Journey aane aur loader hatne par aage badho
    if (reviewPage && !wait) {
        diagnosticLogs.push(
            "Review Journey page detected and loader finished. First Continue successful."
        );
          break;
       }
   }
}

// SECOND CONTINUE
diagnosticLogs.push(
    "First Continue processing complete. Searching next Continue..."
);
var continueBtn2 = null;
var secondFindRetry = 0;
var previousSecondFindPopup = false;
var secondFindLimit = 60;
var secondFindWaitCycles = 0;
var secondFindWaitCycleLimit = 300;
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
        setTimeout(r, 200);
    });
    var txt2 =
        (document.body.innerText || '').toLowerCase();
    var popup2 =
        txt2.includes('high load') ||
        txt2.includes('unable to process') ||
        txt2.includes('please retry');
    if (popup2) {
        var isNewFindPopup = !previousSecondFindPopup;
previousSecondFindPopup = true;
if (!isNewFindPopup) {
    continue;
}
secondFindRetry++;
        diagnosticLogs.push(
            "Second Continue page error. Retry " +
            secondFindRetry +
            "/" +
            secondFindLimit
        );
var detectedError = getIRCTCErrorStatus(
    document.body.innerText || ''
);
await liveProgress(
    detectedError.step,
    detectedError.message,
    20
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
                    'Second Continue button nahi mila after 20 retries.',
                logs: diagnosticLogs
            };
        }
        continue;
    }
        previousSecondFindPopup = false;
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
// WL CONFIRMATION - REVIEW PAGE
// SECOND CONTINUE SE PEHLE
var reviewPageText = document.body.innerText || '';
var isReviewPage =
    /passenger\s+(?:details|information)/i.test(reviewPageText);
var wlMatch = isReviewPage
    ? reviewPageText.match(
        /\b((?:TQWL|GNWL|RLWL|PQWL|RQWL|RSWL|WL)\s*\d+\s*\/\s*(?:WL\s*)?\d+)\b/i
      )
    : null;
if (wlMatch) {
    var detectedWL = wlMatch[1].replace(/\s+/g, '');
    diagnosticLogs.push(
        'WL detected on review page: ' + detectedWL
    );
    if (
        typeof window.__bossRequestWLDecision !== 'function'
    ) {
        return {
            success: false,
            cancelled: true,
            error: 'WL confirmation popup bridge missing. Booking stopped.',
            logs: diagnosticLogs
        };
    }
    var wlDecision = 'cancel';
    try {
        wlDecision = await window.__bossRequestWLDecision(
            detectedWL
        );
    } catch (wlError) {
        diagnosticLogs.push(
            'WL decision error: ' + wlError.message
        );
    }
    if (wlDecision !== 'proceed') {
        diagnosticLogs.push(
            'User cancelled WL booking. Continue not clicked.'
        );
        return {
            success: false,
            cancelled: true,
            error: 'Booking cancelled by user at WL confirmation.',
            logs: diagnosticLogs
        };
    }
    diagnosticLogs.push(
        'User approved WL booking. Proceeding to second Continue.'
    );
}
continueBtn2.click();
diagnosticLogs.push(
    "Second Continue button clicked."
);
// SECOND CONTINUE RETRY - MAXIMUM 10 RETRIES
var isWEB4SecondContinue =
    String(payload.browserType || '')
        .trim()
        .toUpperCase() === 'WEB4';
var secondRetry = 0;
var secondRetryLimit = 20;
var secondWaitCycles = 0;
var secondWaitCycleLimit = 360;
var previousSecondPopup = false;
var secondRetryPending = false;
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
    var web4SecondToastError =
    isWEB4SecondContinue
        ? getWEB4ToastError().toLowerCase()
        : '';
var popup3 =
    (
        isWEB4SecondContinue &&
        (
            web4SecondToastError.includes('unable to process') ||
            web4SecondToastError.includes('high load') ||
            web4SecondToastError.includes('please retry')
        )
    ) ||
    (
        !isWEB4SecondContinue &&
        (
            txt3.includes('high load') ||
            txt3.includes('unable to process') ||
            txt3.includes('please retry')
        )
    );
    // ERROR POPUP DETECTION
    if (popup3) {
        var isNewSecondPopup = !previousSecondPopup;
        previousSecondPopup = true;
        if (isNewSecondPopup) {
            secondRetry++;
            diagnosticLogs.push(
                "Second Continue error popup. Retry " +
                secondRetry + "/" + secondRetryLimit
            );
            var detectedError = getIRCTCErrorStatus(
                document.body.innerText || ''
            );
            await liveProgress(
                detectedError.step,
                detectedError.message,
                20
            );
            if (secondRetry > secondRetryLimit) {
                return {
                    success: false,
                    error:
                        'Second Continue failed after 20 retries.',
                    logs: diagnosticLogs
                };
            }
            secondRetryPending = true;
            // Close error toast
            var close3 = document.querySelector(
                'a.ui-toast-close-icon.pi.pi-times, .ui-toast button'
            );
            if (close3) {
                try {
                    close3.click();
                    diagnosticLogs.push(
                        "Second Continue error toast closed. Waiting 2 seconds before retry..."
                    );
                } catch (e) {
                    diagnosticLogs.push(
                        "Second Continue toast close error: " +
                        e.message
                    );
                }
            }
            // Exactly 2 seconds wait before retry click
            await new Promise(function(r) {
                setTimeout(r, 2000);
            });
            // Fresh Continue button
            var retryBtn = Array.from(
                document.querySelectorAll('button')
            ).find(function(b) {
                var t = (b.innerText || '')
                    .trim()
                    .toLowerCase();
return (
    (
        isWEB4SecondContinue
            ? t === 'continue to payment'
            : t === 'continue'
    ) &&
    b.offsetParent !== null &&
    !b.disabled
);
});
            if (retryBtn) {
                retryBtn.click();
                secondRetryPending = false;
                diagnosticLogs.push(
                    "Second Continue retry click successful: " +
                    secondRetry + "/" + secondRetryLimit
                );
            } else {
                diagnosticLogs.push(
                    "Second Continue button not ready. " +
                    "Will search again after popup clears."
                );
            }
        }
        // Same popup abhi visible hai; duplicate retry count na karein.
        continue;
    }
    // Popup disappear ho gaya
    previousSecondPopup = false;
    // Agar pichhli baar button nahi mila tha, ab dobara search karein.
    if (secondRetryPending) {
        var retryBtnAfterPopup = Array.from(
            document.querySelectorAll('button')
        ).find(function(b) {
            var t = (b.innerText || '')
                .trim()
                .toLowerCase();
return (
    (
        isWEB4SecondContinue
            ? t === 'continue to payment'
            : t === 'continue'
    ) &&
    b.offsetParent !== null &&
    !b.disabled
);
        });
        if (retryBtnAfterPopup) {
            retryBtnAfterPopup.click();
            secondRetryPending = false;
            diagnosticLogs.push(
                "Second Continue retry clicked after button became available."
            );
            continue;
        }
        diagnosticLogs.push(
            "Waiting for Second Continue button to become available."
        );
        continue;
    }
    // WAIT FOR PAGE RESPONSE
    var stillProcessing =
        txt3.includes('please wait') ||
        txt3.includes('processing');
    if (stillProcessing) {
        continue;
    }
    // No error popup and no processing message:
    // continue existing flow.
    break;
}
await liveProgress(
    'PAYMENT',
    'INITILIZE PAYMENT.....',
    70
);
// FINAL PAYMENT PAGE LOADER COMPLETE
diagnosticLogs.push(
    "Continue processing completed."
);
// PAYMENT METHOD SELECTION - NEW IRCTC PAYMENT PAGE
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
// PAYMENT MUST BE PRESENT
if (!selectedPayment) {
    return {
        success: false,
        error:
            'Payment type payload mein empty hai. Form se PAYTM QR / PHONEPE QR / RAZORPAY value nahi aa rahi.',
        logs: diagnosticLogs
    };
}
// NORMALIZE PAYMENT TYPE
var paymentIsPaytm =
    selectedPayment === 'PAYTM QR' ||
    selectedPayment === 'PAYTMQR' ||
    selectedPayment.indexOf('PAYTM') === 0;
var paymentIsPhonePe =
    selectedPayment === 'PHONEPE QR' ||
    selectedPayment === 'PHONEPEQR' ||
    selectedPayment.indexOf('PHONEPE') === 0;
var paymentIsRazorpay =
    selectedPayment === 'RAZORPAY QR' ||
    selectedPayment === 'RAZORPAYQR' ||
    selectedPayment.indexOf('RAZORPAY') === 0;
if (!paymentIsPaytm && !paymentIsPhonePe && !paymentIsRazorpay ) {
    return {
        success: false,
        error:
            'Unknown payment type payload mein aa raha hai: ' +
            selectedPayment,
        logs: diagnosticLogs
    };
}
var providerName = paymentIsPaytm ? 'PAYTM' : paymentIsPhonePe ? 'PHONEPE' : 'RAZORPAY';
// WEB4 ONLY: Firefox Beta payment selection
var isFirefoxWEB4Payment =
    String(payload.browserType || '')
        .trim()
        .toUpperCase() === 'WEB4';
var web4PaymentAlt = paymentIsPaytm
    ? 'Paytm'
    : paymentIsPhonePe
        ? 'PhonePe'
        : 'Razorpay';
if (isFirefoxWEB4Payment) {
    diagnosticLogs.push(
        'WEB4: Multiple Payment Service already available; skipping its selection.'
    );
}
diagnosticLogs.push(
    "Normalized payment: " +
    (paymentIsPaytm ? 'PAYTM QR' : paymentIsPhonePe ? 'PHONEPE QR' : 'RAZORPAY QR')
);
diagnosticLogs.push(
    "Payment provider target: " +
    providerName
);
// PAYTM / PHONEPE
// PEHLE MULTIPLE PAYMENT SERVICE CLICK HOGA.
diagnosticLogs.push(
    providerName + " QR selected."
);
if (!isFirefoxWEB4Payment) {
    diagnosticLogs.push(
        "STEP 1: Pehle Multiple Payment Service select karenge."
    );
}
// FIND MULTIPLE PAYMENT SERVICE
if (!isFirefoxWEB4Payment) {
var multiplePaymentService = null;
var multiPaymentDeadline = Date.now() + 60000;
while (Date.now() < multiPaymentDeadline) {
    try {
        var bankTypeElements = Array.from(
            document.querySelectorAll('.bank-type')
        );
        multiplePaymentService = bankTypeElements.find(function(el) {
            if (
                !el ||
                !el.isConnected ||
                el.offsetParent === null
            ) {
                return false;
            }
            var ariaDisabled = String(
                el.getAttribute('aria-disabled') || ''
            ).trim().toLowerCase();
            if (ariaDisabled === 'true') {
                return false;
            }
            var txt = String(
                el.innerText || el.textContent || ''
            )
                .replace(/\s+/g, ' ')
                .trim()
                .toUpperCase();
            return txt.indexOf('MULTIPLE PAYMENT SERVICE') !== -1;
        });
        if (multiplePaymentService) {
            diagnosticLogs.push(
                "SUCCESS: Multiple Payment Service option found."
            );
            break;
        }
    } catch (e) {}
    await new Promise(function(resolve) {
        setTimeout(resolve, 250);
    });
}
if (!multiplePaymentService) {
    diagnosticLogs.push(
        "TIMEOUT: Multiple Payment Service 60 seconds mein nahi mila."
    );
    return {
        success: false,
        error: 'Multiple Payment Service option 60 seconds mein nahi mila.',
        logs: diagnosticLogs
    };
}
diagnosticLogs.push(
    "Multiple Payment Service element found."
);
// ACTIVE STATE CHECK
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
// CLICK MULTIPLE PAYMENT SERVICE
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
// WAIT FOR MULTIPLE PAYMENT SERVICE TO ACTIVATE
diagnosticLogs.push(
    "STEP 2: Multiple Payment Service activation verify kar rahe hain..."
);
var multipleVerified = false;
var multiVerifyDeadline = Date.now() + 60000;
while (Date.now() < multiVerifyDeadline) {
    var freshMultiplePaymentService = null;
    try {
        freshMultiplePaymentService = Array.from(
            document.querySelectorAll('.bank-type')
        ).find(function(el) {
            if (
                !el ||
                !el.isConnected ||
                el.offsetParent === null
            ) {
                return false;
            }
            var txt = String(
                el.innerText || el.textContent || ''
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
        setTimeout(resolve, 250);
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
}
// PROVIDER SEARCH
if (!isFirefoxWEB4Payment) {
    diagnosticLogs.push(
        "STEP 3: Ab " +
        providerName +
        " side option search karenge."
    );
}
var providerElement = null;
var providerDeadline = Date.now() + 60000;
while (Date.now() < providerDeadline) {
    providerElement = null;
    try {
        var providerElements = Array.from(
            document.querySelectorAll(
                '.border-all.link, .col-pad a, .col-pad button, .bank-type'
            )
        );
        function isUsableProviderElement(el) {
            if (
                !el ||
                !el.isConnected ||
                el.offsetParent === null ||
                el.disabled === true
            ) {
                return false;
            }
            var ariaDisabled = String(
                el.getAttribute &&
                el.getAttribute('aria-disabled') || ''
            ).trim().toLowerCase();
            return ariaDisabled !== 'true';
        }

if (isFirefoxWEB4Payment) {
    // WEB4 ONLY: provider ko button ke aria-label se find karo
    var web4PaymentButton = Array.from(
        document.querySelectorAll(
            'button.bank-card[aria-label]'
        )
    ).find(function(btn) {
        if (
            !btn ||
            !btn.isConnected ||
            btn.offsetParent === null ||
            btn.disabled === true
        ) {
            return false;
        }

        var label = String(
            btn.getAttribute('aria-label') || ''
        ).trim().toUpperCase();

        return label === web4PaymentAlt.toUpperCase();
    });

    if (web4PaymentButton) {
        providerElement = web4PaymentButton;
    }
} else {

            // OLD WEB / WEB2 / WEB3 CODE — unchanged
            providerElement = providerElements.find(function(el) {
                if (!isUsableProviderElement(el)) {
                    return false;
                }
                var txt = String(
                    el.innerText || el.textContent || ''
                )
                    .replace(/\s+/g, ' ')
                    .trim()
                    .toUpperCase();
                return txt === providerName;
            });
            if (!providerElement) {
                providerElement = providerElements.find(function(el) {
                    if (!isUsableProviderElement(el)) {
                        return false;
                    }
                    var txt = String(
                        el.innerText || el.textContent || ''
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
        }
        if (providerElement) {
            diagnosticLogs.push(
                "SUCCESS: " + providerName +
                " provider option found."
            );
            break;
        }
    } catch (e) {}
    await new Promise(function(resolve) {
        setTimeout(resolve, 250);
    });
}
// PROVIDER NOT FOUND
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
// PROVIDER FOUND
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
// CLICK PROVIDER
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

if (isFirefoxWEB4Payment) {
    var web4SelectionConfirmed = false;
    var web4SelectionDeadline = Date.now() + 5000;

    while (Date.now() < web4SelectionDeadline) {
        if (
            providerElement &&
            providerElement.isConnected &&
            String(providerElement.getAttribute('aria-pressed') || '').toLowerCase() === 'true'
        ) {
            web4SelectionConfirmed = true;
            break;
        }

        await new Promise(function(resolve) {
            setTimeout(resolve, 200);
        });
    }

    if (!web4SelectionConfirmed) {
        throw new Error(
            'WEB4: ' + web4PaymentAlt +
            ' click hua, lekin selection confirm nahi hua.'
        );
    }

    diagnosticLogs.push(
        'WEB4: ' + web4PaymentAlt +
        ' payment selected and verified.'
    );
}

diagnosticLogs.push(
    providerName +
    " selected. Ab directly Pay & Book dhoondhenge."
);
// PAY & BOOK BUTTON + ERROR RETRY
diagnosticLogs.push(
    "Waiting for Pay & Book button to appear..."
);
var payAndBookBtn = null;
async function reselectRequestedPayment() {
    diagnosticLogs.push(
        "RETRY: Re-selecting requested payment: " +
        providerName
    );
    // MULTIPLE PAYMENT SERVICE
if (!isFirefoxWEB4Payment) {
    var multiOption = null;
    var multiDeadline = Date.now() + 15000;
    while (Date.now() < multiDeadline) {
        multiOption = Array.from(
            document.querySelectorAll('.bank-type')
        ).find(function(el) {
            if (
                !el ||
                !el.isConnected ||
                el.offsetParent === null
            ) {
                return false;
            }
            var txt = String(
                el.innerText || el.textContent || ''
            ).replace(/\s+/g, ' ').trim().toUpperCase();
            return txt.includes('MULTIPLE PAYMENT SERVICE');
        });
        if (multiOption) break;
        await new Promise(function(r) {
            setTimeout(r, 250);
        });
    }
    if (!multiOption) {
        diagnosticLogs.push(
            "RETRY ERROR: Multiple Payment Service not found."
        );
        return false;
    }
    if (!isMultiplePaymentServiceActive(multiOption)) {
        multiOption.click();
        await new Promise(function(r) {
            setTimeout(r, 500);
        });
    }
}
    // RESELECT THE SAME REQUESTED PROVIDER
    var wantedProvider = String(
        providerName || ''
    ).replace(/\s+/g, ' ').trim().toUpperCase();
    var providerDeadline = Date.now() + 15000;
    var retryProvider = null;
    while (Date.now() < providerDeadline) {

if (isFirefoxWEB4Payment) {
    // WEB4 ONLY: retry mein aria-label se provider find karo
    retryProvider = Array.from(
        document.querySelectorAll(
            'button.bank-card[aria-label]'
        )
    ).find(function(btn) {
        if (
            !btn ||
            !btn.isConnected ||
            btn.offsetParent === null ||
            btn.disabled === true
        ) {
            return false;
        }

        var label = String(
            btn.getAttribute('aria-label') || ''
        ).trim().toUpperCase();

        return label === web4PaymentAlt.toUpperCase();
    }) || null;
} else {

            // OLD WEB / WEB2 / WEB3 RETRY SEARCH — unchanged
            retryProvider = Array.from(
                document.querySelectorAll(
                    '.border-all.link, .col-pad a, ' +
                    '.col-pad button, .bank-type'
                )
            ).find(function(el) {
                if (
                    !el ||
                    !el.isConnected ||
                    el.offsetParent === null ||
                    el.disabled === true
                ) {
                    return false;
                }
                var ariaDisabled = String(
                    el.getAttribute('aria-disabled') || ''
                ).trim().toLowerCase();
                if (ariaDisabled === 'true') return false;
                var txt = String(
                    el.innerText || el.textContent || ''
                ).replace(/\s+/g, ' ').trim().toUpperCase();
                return (
                    txt === wantedProvider ||
                    (
                        wantedProvider.length > 0 &&
                        txt.includes(wantedProvider) &&
                        txt.length <= 80
                    )
                );
            });
        }
        if (retryProvider) break;
        await new Promise(function(r) {
            setTimeout(r, 250);
        });
    }
    if (!retryProvider) {
        diagnosticLogs.push(
            "RETRY ERROR: Requested provider not found: " +
            providerName
        );
        return false;
    }
    retryProvider.click();
    diagnosticLogs.push(
        "RETRY: Same provider selected again: " +
        providerName
    );
    await new Promise(function(r) {
        setTimeout(r, 500);
    });
    return true;
}
var payBookRetry = 0;
var payBookRetryLimit = 10;
for (;;) {
    // ON RETRY, RESELECT THE SAME PAYMENT PROVIDER
    if (payBookRetry > 0) {
        var paymentReselected =
            await reselectRequestedPayment();
        if (!paymentReselected) {
            return {
                success: false,
                error:
                    'Retry mein selected payment provider dobara select nahi hua.',
                logs: diagnosticLogs
            };
        }
    }
    // FIND FRESH PAY & BOOK BUTTON
var payBookDeadline = Date.now() + 60000;
while (Date.now() < payBookDeadline) {
    payAndBookBtn = null;
    try {
        payAndBookBtn = Array.from(
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
            var ariaDisabled = String(
                button.getAttribute &&
                button.getAttribute('aria-disabled') || ''
            ).trim().toLowerCase();
            if (ariaDisabled === 'true') {
                return false;
            }
            var text = String(
                button.innerText || button.textContent || ''
            )
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
            return (
                text.indexOf('pay & book') !== -1 ||
                text.indexOf('make payment') !== -1
            );
        });
        if (payAndBookBtn) {
            break;
        }
    } catch (e) {}
    await new Promise(function(resolve) {
        setTimeout(resolve, 250);
    });
}
    // PAY & BOOK NOT FOUND
    if (!payAndBookBtn) {
        return {
            success: false,
            error:
                'Pay & Book button nahi mila (Page load timeout).',
            logs: diagnosticLogs
        };
    }
    // CLICK PAY & BOOK
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
    payBookRetry++;
    diagnosticLogs.push(
        "Pay & Book click failed. Retry " +
        payBookRetry + "/" + payBookRetryLimit
    );
    if (payBookRetry >= payBookRetryLimit) {
        return {
            success: false,
            error: 'Pay & Book failed after 10 retries.',
            logs: diagnosticLogs
        };
    }
    await new Promise(function(r) {
        setTimeout(r, 500);
    });
    continue;
}
    // CHECK RESULT / ERROR POPUP
    var payBookRetryAlreadyCounted = false;
    var payBookSuccess = false;
    var payWaitDeadline = Date.now() + 60000;
while (Date.now() < payWaitDeadline) {
    await new Promise(function(resolve) {
        setTimeout(resolve, 250);
    });
    var payText =
        (document.body.innerText || '').toLowerCase();
        // HIGH LOAD / UNABLE / PLEASE RETRY
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
var detectedError = getIRCTCErrorStatus(
    document.body.innerText || ''
);
await liveProgress(
    detectedError.step,
    detectedError.message,
    20
);
            // EXACT IRCTC TOAST CLOSE BUTTON
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
        // VERIFY ACTUAL PROVIDER QR
var actualQrReady = false;
try {
    if (paymentIsPaytm) {
        var paytmImage = document.querySelector(
            'img[data-key="qr-code"]'
        );
        actualQrReady = !!(
            paytmImage &&
            paytmImage.isConnected &&
            paytmImage.offsetParent !== null &&
            paytmImage.complete &&
            paytmImage.naturalWidth >= 100 &&
            paytmImage.naturalHeight >= 100
        );
    } else if (paymentIsPhonePe) {
        var phonepeCandidates = Array.from(
            document.querySelectorAll(
                'img[src*="qr" i], ' +
                'img[alt*="qr" i], ' +
                'img[src^="blob:"], canvas'
            )
        );
        actualQrReady = phonepeCandidates.some(
            function(el) {
                if (
                    !el.isConnected ||
                    el.offsetParent === null
                ) {
                    return false;
                }
                if (el instanceof HTMLImageElement) {
                    return (
                        el.complete &&
                        el.naturalWidth >= 100 &&
                        el.naturalHeight >= 100
                    );
                }
                return (
                    el instanceof HTMLCanvasElement &&
                    el.width >= 100 &&
                    el.height >= 100
                );
            }
        );
    } else if (paymentIsRazorpay) {
        // RAZORPAY: Verify actual loaded UPI QR image.
        var razorpayImage = document.querySelector(
            'img[alt="UPI QR Code"]'
        );
        if (razorpayImage) {
            var razorpayRect =
                razorpayImage.getBoundingClientRect();
            var razorpayStyle =
                window.getComputedStyle(razorpayImage);
            actualQrReady = !!(
                razorpayImage.isConnected &&
                razorpayRect.width >= 100 &&
                razorpayRect.height >= 100 &&
                razorpayStyle.display !== 'none' &&
                razorpayStyle.visibility !== 'hidden' &&
                Number(razorpayStyle.opacity) !== 0 &&
                razorpayImage.complete &&
                razorpayImage.naturalWidth >= 100 &&
                razorpayImage.naturalHeight >= 100
            );
        }
    }
} catch (qrCheckError) {
    diagnosticLogs.push(
        "QR verification error: " +
        qrCheckError.message
    );
}
if (actualQrReady) {
    payBookSuccess = true;
    diagnosticLogs.push(
        "SUCCESS: Actual selected-provider QR detected."
    );
    break;
}
}
console.log(
    '[QR DEBUG] Payment detection loop completed. payBookSuccess =',
    payBookSuccess
);
    // RETRY OR STOP AFTER RESULT CHECK
    // QR mil gaya: selected provider ka QR confirm hai.
    if (payBookSuccess) {
        diagnosticLogs.push(
            "SUCCESS: Pay & Book completed. Payment QR detected."
        );
        return {
            success: true,
            paymentMethod: selectedPayment,
            totalFare: payload.realFare,
            logs: diagnosticLogs,
            message: 'Pay & Book clicked successfully.'
        };
    }
    // Error popup mila tha: outer for-loop mein wapas jao.
    // Isse next attempt mein provider reselect hoga.
    if (payBookRetryAlreadyCounted) {
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
        diagnosticLogs.push(
            "Retry " + (payBookRetry + 1) +
            "/" + payBookRetryLimit +
            ": selected provider dobara select karke Pay & Book retry hoga."
        );
        await new Promise(function(resolve) {
            setTimeout(resolve, 1500);
        });
        continue;
    }
    // Na QR mila, na known error popup.
    // Is condition mein blind duplicate click mat karo.
    diagnosticLogs.push(
        "QR ya recognized error popup nahi mila. " +
        "Page state verify kiye bina duplicate Pay & Book click nahi kiya."
    );
    return {
        success: false,
        error:
            'Pay & Book ke baad QR ya recognized error detect nahi hua.',
        logs: diagnosticLogs
    };
}
// OUTER BROWSER AUTOMATION TRY/CATCH
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
    // WL CONFIRMATION BRIDGE
    // BROWSER PAGE -> NODE -> MINI WINDOW
if (this._wlConfirmationBridgePage !== this.page) {
    await this.page.exposeFunction(
        '__bossRequestWLDecision',
        async (wlNumber) => {
            console.log(
                `[WL BRIDGE] Decision request received: ${wlNumber}`
            );
            if (
                !this.qrCallbacks ||
                typeof this.qrCallbacks.requestWLDecision !== 'function'
            ) {
                console.error(
                    '[WL BRIDGE] requestWLDecision callback missing.'
                );
                return 'cancel';
            }
            try {
                const decision =
                    await this.qrCallbacks.requestWLDecision(wlNumber);
                console.log(
                    '[WL BRIDGE] User decision received:',
                    decision
                );
                return decision === 'proceed'
                    ? 'proceed'
                    : 'cancel';
            } catch (error) {
                console.error(
                    '[WL BRIDGE] Decision failed:',
                    error.message
                );
                return 'cancel';
            }
        }
    );
    this._wlConfirmationBridgePage = this.page;
    console.log(
        `[WL BRIDGE] Confirmation bridge ready for ${this.browserType}.`
    );
} else {
    console.log(
        `[WL BRIDGE] Already registered for ${this.browserType}. Skipping duplicate registration.`
    );
}
// LIVE BOOKING PROGRESS BRIDGE
// NODE -> BROWSER PAGE
if (this._bookingProgressBridgePage !== this.page) {
    await this.page.exposeFunction(
        '__bossSendProgress',
        (step, message, percentage) => {
            try {
    this.sendBookingStatus(
        message,
        step,
        percentage
    );
} catch (error) {
    console.warn(
        '[PROGRESS BRIDGE] Status send failed:',
        error.message
    );
}
        }
    );
  this._bookingProgressBridgePage = this.page;
    console.log(
        `[PROGRESS BRIDGE] Live booking progress bridge ready for ${this.browserType}.`
    );
}
// LIVE AVAILABILITY & FARE BRIDGE (DOM -> NODE -> MINI WINDOW)
if (this._avlFareBridgePage !== this.page) {
    await this.page.exposeFunction(
        '__bossSendAvlFare',
        (availability, fare) => {
            try {
                if (fare && fare !== '--') {
                    bookingData.realFare = String(fare).replace(/[^\d.]/g, '');
                }
                this.sendAvailabilityFare(availability, fare);
            } catch (err) {
                console.warn('[AVL FARE BRIDGE] Send failed:', err.message);
            }
        }
    );
    this._avlFareBridgePage = this.page;
}
// NAVIGATION-SAFE PAYMENT PAGE HANDLER
const automationUrlBefore = this.page.url();
try {
    result = await this.page.evaluate(script);
} catch (automationEvalError) {
    const errorMessage = String(
        automationEvalError?.message || automationEvalError
    );
   const navigationContextLost =
        /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed|Browsing context has been discarded|Document was unloaded|NS_BINDING_ABORTED/i
            .test(errorMessage);
    if (!navigationContextLost) {
        throw automationEvalError;
    }
    this.sendBookingStatus(
        'VERIFYING PAYMENT PAGE...',
        'Payment page load hone ka wait ho raha hai...',
        75
    );
    let paymentPageState = null;
    const expectedPayment = String(
        bookingData.payment ||
        bookingData.paymentType ||
        bookingData.paymentMethod ||
        ''
    ).trim().toUpperCase();
    if (!expectedPayment) {
        throw new Error(
            'Navigation recovery mein payment method nahi mila.'
        );
    }
let razorpayShowQrClicked = false;
// Maximum 5 minutes.
 // Pay & Book dobara click nahi hoga.
const paymentVerificationDeadline = Date.now() + (5 * 60 * 1000);
for (
    let i = 0;
    Date.now() < paymentVerificationDeadline;
    i++
) {
    if (!this.page || this.page.isClosed()) {
        break;
    }
    try {
        // WAIT FOR PAYMENT PAGE
        // Razorpay checkout alag page/frame mein hai.
        // Isliye Razorpay ke liye main-page wait skip.
        if (!expectedPayment.startsWith('RAZORPAY')) {
            await this.page.waitForFunction(
                () =>
                    document.readyState === 'interactive' ||
                    document.readyState === 'complete',
                { timeout: 3000 }
            );
        }
        // RAZORPAY: Retry locating Show QR across checkout frames.
        if (
            expectedPayment.startsWith('RAZORPAY') &&
            !razorpayShowQrClicked
        ) {
            try {
                const browserPages = await this.page.browser().pages();
                for (const candidatePage of browserPages) {
                    if (
                        candidatePage.isClosed() ||
                        !candidatePage.url().startsWith(
                            'https://checkout-hosted.razorpay.com/orders/'
                        )
                    ) {
                        continue;
                    }
                    for (const frame of candidatePage.frames()) {
                        try {
                            const button = await frame.$(
                                'span[name="generateQR"]'
                            );
                            if (!button) continue;
                            const clicked = await button.evaluate(el => {
                                const text = (
                                    el.innerText ||
                                    el.textContent ||
                                    ''
                                ).replace(/\s+/g, ' ').trim().toLowerCase();
                                const rect = el.getBoundingClientRect();
                                const style = getComputedStyle(el);
                                if (
                                    text !== 'show qr' ||
                                    rect.width <= 0 ||
                                    rect.height <= 0 ||
                                    style.display === 'none' ||
                                    style.visibility === 'hidden'
                                ) {
                                    return false;
                                }
                                el.click();
                                return true;
                            });
if (clicked) {
    // Show QR ke baad Continue & Pay button ka wait.
    let continuePayClicked = false;
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            const continuePayButton = await frame.$(
                'button[data-testid="fee-bearer-cta"]'
            );
            if (continuePayButton) {
                const buttonInfo = await continuePayButton.evaluate(el => {
                    const rect = el.getBoundingClientRect();
                    const style = getComputedStyle(el);
                    return {
                        text: (el.innerText || el.textContent || '')
                            .replace(/\s+/g, ' ')
                            .trim(),
                        visible: rect.width > 0 &&
                            rect.height > 0 &&
                            style.display !== 'none' &&
                            style.visibility !== 'hidden',
                        enabled: !el.disabled
                    };
                });
                if (
                    buttonInfo.text === 'Continue & Pay' &&
                    buttonInfo.visible &&
                    buttonInfo.enabled
                ) {
                    await continuePayButton.click({ timeout: 3000 });
                    continuePayClicked = true;
                    break;
                }
            }
        } catch (_) {
            // Frame navigation ho to agle attempt mein retry.
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!continuePayClicked) {
        throw new Error(
            'Razorpay Continue & Pay button nahi mila ya click nahi hua.'
        );
    }
    razorpayShowQrClicked = true;
    break;
}
                        } catch (_) {
                            // Frame navigate ho raha hai; agle attempt mein retry.
                        }
                    }
                    if (razorpayShowQrClicked) break;
                }
            } catch (_) {
                // Checkout navigation ke dauran retry.
            }
        }
        // RAZORPAY: FAST PARALLEL QR VERIFICATION
        if (expectedPayment.startsWith('RAZORPAY')) {
            let razorpayQrVerified = false;
            let razorpayVerifiedUrl = '';
            try {
                const browserPages = await this.page.browser().pages();
                for (const candidatePage of browserPages) {
                    if (
                        candidatePage.isClosed() ||
                        !candidatePage.url().startsWith(
                            'https://checkout-hosted.razorpay.com/orders/'
                        )
                    ) {
                        continue;
                    }
                    const frames = candidatePage.frames();
                    // Sabhi frames ek saath check honge.
                    const frameChecks = frames.map(async (frame) => {
                        let timeoutId;
                        try {
                            const qrFound = await Promise.race([
                                frame.evaluate(() => {
                                    const selectors = [
                                        'img[alt*="qr" i]',
                                        'img[src*="qr" i]',
                                        'img[src^="blob:"]',
                                        'canvas'
                                    ];
                                    for (const selector of selectors) {
                                        for (const el of document.querySelectorAll(selector)) {
                                            const rect = el.getBoundingClientRect();
                                            const style = getComputedStyle(el);
                                            const visible =
                                                rect.width >= 100 &&
                                                rect.height >= 100 &&
                                                style.display !== 'none' &&
                                                style.visibility !== 'hidden' &&
                                                Number(style.opacity) !== 0;
                                            if (!visible) continue;
                                            if (
                                                el instanceof HTMLImageElement &&
                                                el.complete &&
                                                el.naturalWidth >= 100 &&
                                                el.naturalHeight >= 100
                                            ) {
                                                return true;
                                            }
                                            if (
                                                el instanceof HTMLCanvasElement &&
                                                el.width >= 100 &&
                                                el.height >= 100
                                            ) {
                                                return true;
                                            }
                                        }
                                    }
                                    return false;
                                }),
                                new Promise((_, reject) => {
                                    timeoutId = setTimeout(() => {
                                        reject(new Error('Frame QR check timeout'));
                                    }, 700);
                                })
                            ]);
                            if (qrFound === true) {
                                return true;
                            }
                            throw new Error('QR not found in this frame');
                        } catch (_) {
                            return false;
                        } finally {
                            clearTimeout(timeoutId);
                        }
                    });
                    // Pehla valid QR milte hi wait khatam.
                    const firstQr = await Promise.any(
                        frameChecks.map(async (check) => {
                            const found = await check;
                            if (!found) {
                                throw new Error('QR not found');
                            }
                            return true;
                        })
                    ).catch(() => false);
                    if (firstQr) {
                        razorpayQrVerified = true;
                        razorpayVerifiedUrl = candidatePage.url();
                        console.log(
                            '[RAZORPAY] QR verified immediately:',
                            razorpayVerifiedUrl
                        );
                        break;
                    }
                }
            } catch (error) {
                console.warn(
                    '[RAZORPAY] QR verification retry:',
                    error.message
                );
            }
            if (razorpayQrVerified) {
                // 0ms INSTANT PUSH: QR load hote hi wahin se mini window par bhej dein
                try {
                    let instantImg = null;
                    let instantTmr = null;
                    let instantAmt = null;

                    const pages = await this.page.browser().pages();
                    for (const p of pages) {
                        if (p.isClosed() || !p.url().startsWith('https://checkout-hosted.razorpay.com/orders/')) continue;
                        await Promise.all(p.frames().map(async (f) => {
                            try {
                                const data = await f.evaluate(() => {
                                    let qr = null, tmr = null, amt = null;
                                    // 1. Grab QR Base64 directly
                                    const imgs = Array.from(document.querySelectorAll('img[alt="UPI QR Code"], img[alt*="qr" i], img[src^="data:image/"]'));
                                    for (const im of imgs) {
                                        const r = im.getBoundingClientRect();
                                        if (r.width >= 100 && r.height >= 100 && im.complete && im.naturalWidth >= 100) {
                                            if ((im.currentSrc || im.src || '').startsWith('data:image/')) {
                                                qr = im.currentSrc || im.src;
                                                break;
                                            }
                                            try {
                                                const c = document.createElement('canvas');
                                                c.width = im.naturalWidth;
                                                c.height = im.naturalHeight;
                                                c.getContext('2d').drawImage(im, 0, 0);
                                                qr = c.toDataURL('image/png');
                                                break;
                                            } catch (_) {}
                                        }
                                    }
                                    // 2. Grab Exact Razorpay Timer
                                    for (const el of document.querySelectorAll('span')) {
                                        const t = (el.innerText || '').trim();
                                        if (/^\d{1,2}:\d{2}$/.test(t)) {
                                            const [m, s] = t.split(':').map(Number);
                                            if (m >= 0 && m <= 60 && s >= 0 && s <= 59) {
                                                tmr = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
                                                break;
                                            }
                                        }
                                    }
                                    // 3. Grab Exact Razorpay Amount
                                    const amtEl = document.querySelector('h3[data-testid="summary-amount"]');
                                    if (amtEl) {
                                        const v = amtEl.getAttribute('data-value');
                                        amt = (v && /^\d+$/.test(v)) ? (Number(v) / 100).toFixed(2) : (amtEl.innerText || '').replace(/[^\d.]/g, '').trim();
                                    }
                                    return { qr, tmr, amt };
                                });
                                if (data.qr && !instantImg) instantImg = data.qr;
                                if (data.tmr && !instantTmr) instantTmr = data.tmr;
                                if (data.amt && !instantAmt) instantAmt = data.amt;
                            } catch (_) {}
                        }));
                    }

                    if (instantImg && this.win && !this.win.isDestroyed() && this.qrCallbacks?.showQR) {
                        this._instantRazorpaySent = true;
                        this.qrCallbacks.showQR({
                            image: instantImg,
                            remainingTime: instantTmr || '00:00',
                            paymentType: expectedPayment,
                            amount: instantAmt || backendRealFare
                        });
                        console.log('[RAZORPAY 0MS] QR + Amount + Timer pushed immediately on load!');
                    }
                } catch (_) {}

                paymentPageState = {
                    url: razorpayVerifiedUrl,
                    ready: 'complete',
                    text: '',
                    actualQrReady: true,
                    qrType: 'RAZORPAY QR'
                };
                console.log(
                    '[PAYMENT NAVIGATION] Razorpay QR verified:',
                    razorpayVerifiedUrl
                );
                break;
            }
        }
        const state = await this.page.evaluate(
            (expectedPayment) => {
                function visible(el) {
                    return !!(
                        el &&
                        el.isConnected &&
                        el.offsetParent !== null
                    );
                }
                function normalize(text) {
                    return String(text || '')
                        .replace(/\s+/g, ' ')
                        .trim()
                        .toLowerCase();
                }
                function validImage(el) {
                    return (
                        visible(el) &&
                        el.complete &&
                        el.naturalWidth >= 100 &&
                        el.naturalHeight >= 100
                    );
                }
                function validCanvas(el) {
                    return (
                        visible(el) &&
                        el.width >= 100 &&
                        el.height >= 100
                    );
                }
                function findClickableByText(predicate) {
                    const elements = Array.from(
                        document.querySelectorAll(
                            'button, a, label, [role="button"], ' +
                            '[role="tab"], [role="radio"], ' +
                            'input[type="radio"], div, span'
                        )
                    );
                    for (const el of elements) {
                        if (!visible(el)) {
                            continue;
                        }
                        const text = normalize(
                            el.innerText || el.textContent
                        );
                        if (!text || !predicate(text)) {
                            continue;
                        }
                        const clickable = el.closest(
                            'button, a, label, [role="button"], ' +
                            '[role="tab"], [role="radio"]'
                        );
                        if (
                            clickable &&
                            visible(clickable) &&
                            !clickable.disabled &&
                            clickable.getAttribute('aria-disabled') !== 'true'
                        ) {
                            return clickable;
                        }
                    }
                    return null;
                }
        let actualQrReady = false;
        let qrType = '';
        if (expectedPayment.startsWith('PAYTM')) {
            const el = document.querySelector(
                'img[data-key="qr-code"]'
            );
            actualQrReady = validImage(el);
            if (actualQrReady) {
                qrType = 'PAYTM QR';
            }
} else if (expectedPayment.startsWith('RAZORPAY')) {
    const razorpayImage = document.querySelector(
        'img[alt="UPI QR Code"]'
    );
    actualQrReady = validImage(razorpayImage);
    if (actualQrReady) {
        qrType = 'RAZORPAY QR';
    }
} else if (expectedPayment.startsWith('PHONEPE')) {
    // Actual PhonePe payment URL verify karo.
    let phonePeUrlVerified = false;
    try {
        const currentUrl = new URL(window.location.href);
        phonePeUrlVerified =
            currentUrl.protocol === 'https:' &&
            currentUrl.hostname === 'mercury-t2.phonepe.com' &&
            currentUrl.pathname === '/transact/sltv3' &&
            Boolean(currentUrl.searchParams.get('token'));
    } catch (error) {
        phonePeUrlVerified = false;
    }
    const elements = Array.from(
        document.querySelectorAll(
            'img[src*="qr" i], ' +
            'img[alt*="qr" i], ' +
            'img[src^="blob:"], canvas'
        )
    );
    const phonePeQrReady = elements.some(function(el) {
        if (!el.isConnected) {
            return false;
        }
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const visible =
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity) !== 0 &&
            rect.width > 0 &&
            rect.height > 0;
        if (!visible) {
            return false;
        }
        if (el instanceof HTMLImageElement) {
            return (
                el.complete &&
                el.naturalWidth >= 100 &&
                el.naturalHeight >= 100
            );
        }
        if (el instanceof HTMLCanvasElement) {
            return (
                el.width >= 100 &&
                el.height >= 100
            );
        }
        return false;
    });
    // URL aur QR dono valid hone chahiye.
    actualQrReady =
        phonePeUrlVerified && phonePeQrReady;
    if (actualQrReady) {
        qrType = 'PHONEPE QR';
    }
}
        const text = String(
            document.body?.innerText || ''
        ).slice(0, 15000);
        return {
    url: window.location.href,
    ready: document.readyState,
    text: text,
    actualQrReady: actualQrReady,
    qrType: qrType,
    providerUrlVerified:
        typeof phonePeUrlVerified !== 'undefined'
            ? phonePeUrlVerified
            : false
};
    },
    expectedPayment
);
            const hasIrctcError =
                /high load|unable to process|please retry/i
                    .test(state.text);
            const isPhonePeRecovery =
    expectedPayment.startsWith('PHONEPE');
if (
    state.ready !== 'loading' &&
    !hasIrctcError &&
    state.actualQrReady &&
    (
        !isPhonePeRecovery ||
        state.providerUrlVerified === true
    )
) {
    paymentPageState = state;
    break;
}
        } catch (pageCheckError) {
    const message = String(
        pageCheckError?.message || pageCheckError
    );
    const isNavigationError =
        /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed/i
            .test(message);
    if (!isNavigationError) {
        console.warn(
            '[PAYMENT NAVIGATION] QR check error:',
            message
        );
    }
    // Navigation errors par existing retry loop continue karega.
}
        await new Promise(function(resolve) {
            setTimeout(resolve, 500);
        });
    }
    if (!paymentPageState) {
        throw new Error(
            'Navigation ke baad selected provider ka actual QR ' +
            '5 minutes mein verify nahi hua. ' +
            'Duplicate Pay & Book click nahi kiya.'
        );
    }
    console.log(
        '[PAYMENT NAVIGATION] Actual QR verified:',
        paymentPageState.qrType
    );
    console.log(
        '[PAYMENT NAVIGATION] URL:',
        paymentPageState.url
    );
    result = {
        success: true,
        paymentMethod: expectedPayment,
        totalFare: backendRealFare,
        logs: [
            'Navigation detect hui.',
            'Actual provider QR verify hua: ' +
                paymentPageState.qrType,
            'Pay & Book dobara click nahi hua.'
        ],
        message: 'Actual payment QR verified after navigation.'
    };
}
 // PHONEPE PAYMENT PAGE VERIFICATION
const expectedPaymentForVerification = String(
    bookingData.payment ||
    bookingData.paymentType ||
    bookingData.paymentMethod ||
    ''
).trim().toUpperCase();
const isPhonePePayment =
    expectedPaymentForVerification.includes('PHONEPE');
const alreadyVerifiedAfterNavigation = Boolean(
    result &&
    Array.isArray(result.logs) &&
    result.logs.some(log =>
        String(log).includes('Actual provider QR verified')
    )
);
if (
    isPhonePePayment &&
    result &&
    result.success &&
    !alreadyVerifiedAfterNavigation
) {
    this.sendBookingStatus(
        'VERIFYING PAYMENT PAGE...',
        'PhonePe payment page load aur QR verify ho raha hai...',
        75
    );
    console.log(
        '[PHONEPE VERIFICATION] Payment page verification started.'
    );
    let phonePeQrVerified = false;
    for (let attempt = 0; attempt < 60; attempt++) {
        if (!this.page || this.page.isClosed()) {
            break;
        }
        try {
            const phonePeState = await this.page.evaluate(() => {
                function isVisible(el) {
                    if (!el || !el.isConnected) {
                        return false;
                    }
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    return (
                        style.display !== 'none' &&
                        style.visibility !== 'hidden' &&
                        Number(style.opacity) !== 0 &&
                        rect.width > 0 &&
                        rect.height > 0
                    );
                }
                let providerUrlVerified = false;
                try {
                    const url = new URL(window.location.href);
                    providerUrlVerified =
                        url.protocol === 'https:' &&
                        url.hostname === 'mercury-t2.phonepe.com' &&
                        url.pathname === '/transact/sltv3' &&
                        Boolean(url.searchParams.get('token'));
                } catch (error) {
                    providerUrlVerified = false;
                }
                const candidates = Array.from(
                    document.querySelectorAll(
                        'img[src*="qr" i], ' +
                        'img[alt*="qr" i], ' +
                        'img[src^="blob:"], canvas'
                    )
                );
                const qrReady = candidates.some(el => {
                    if (!isVisible(el)) {
                        return false;
                    }
                    if (el instanceof HTMLImageElement) {
                        return (
                            el.complete &&
                            el.naturalWidth >= 100 &&
                            el.naturalHeight >= 100
                        );
                    }
                    if (el instanceof HTMLCanvasElement) {
                        return (
                            el.width >= 100 &&
                            el.height >= 100
                        );
                    }
                    return false;
                });
                return {
                    url: window.location.href,
                    ready: document.readyState,
                    providerUrlVerified,
                    qrReady
                };
            });
            let safeUrl = phonePeState.url;
            try {
                const parsedUrl = new URL(safeUrl);
                if (parsedUrl.searchParams.has('token')) {
                    parsedUrl.searchParams.set(
                        'token',
                        '[REDACTED]'
                    );
                }
                safeUrl = parsedUrl.toString();
            } catch (error) {
                safeUrl = '[INVALID URL]';
            }
            console.log(
                '[PHONEPE VERIFICATION] Attempt:',
                attempt + 1,
                '| URL:',
                safeUrl,
                '| URL Verified:',
                phonePeState.providerUrlVerified,
                '| Ready:',
                phonePeState.ready,
                '| QR:',
                phonePeState.qrReady
            );
            if (
                phonePeState.ready !== 'loading' &&
                phonePeState.providerUrlVerified === true &&
                phonePeState.qrReady === true
            ) {
                phonePeQrVerified = true;
                console.log(
                    '[PAYMENT NAVIGATION] Actual QR verified: PHONEPE QR'
                );
                console.log(
                    '[PAYMENT NAVIGATION] URL:',
                    safeUrl
                );
                break;
            }
        } catch (verificationError) {
            // Navigation ke dauran context change ho sakta hai.
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!phonePeQrVerified) {
        throw new Error(
            'PhonePe ka expected payment URL aur actual QR ' +
            'verify nahi hua. Booking flow aage nahi badhaya gaya.'
        );
    }
    console.log(
        '[PHONEPE VERIFICATION] Actual PhonePe QR verified successfully.'
    );
}

// =========================================================
// RAZORPAY SHOW QR & CONTINUE & PAY (WEB / WEB2 / WEB3 / WEB4)
// Runs regardless of whether browser threw navigation error or returned normally
// =========================================================
const expectedPayMethod = String(
    bookingData.payment ||
    bookingData.paymentType ||
    bookingData.paymentMethod ||
    ''
).trim().toUpperCase();

const alreadyRzpVerified = Boolean(
    result &&
    result.success &&
    String(result.message || '').includes('Actual payment QR verified after navigation')
);

const isAlreadyOnRazorpayVerified = Boolean(
    result &&
    result.success &&
    (
        String(result.message || '').includes('Actual payment QR verified') ||
        this.page.url().includes('checkout-hosted.razorpay.com')
    )
);

if (expectedPayMethod.startsWith('RAZORPAY') && !isAlreadyOnRazorpayVerified) {
    console.log(`[${this.browserType} RAZORPAY] Checking checkout frames for Show QR & Continue & Pay...`);
    let showQrDone = false;
    let continuePayDone = false;
    const rzpDeadline = Date.now() + 60000; // 60 seconds max

    while (Date.now() < rzpDeadline && (!showQrDone || !continuePayDone)) {
        if (!this.page || this.page.isClosed()) break;

        try {
            const allPages = await this.page.browser().pages();
            const targetPages = allPages.filter(p =>
                !p.isClosed() &&
                (p.url().includes('razorpay.com') || p === this.page)
            );

            for (const p of targetPages) {
                for (const frame of p.frames()) {
                    try {
                        // Step A: Click "Show QR"
                        if (!showQrDone) {
                            const clickedQr = await frame.evaluate(() => {
                                const el =
                                    document.querySelector('span[name="generateQR"]') ||
                                    Array.from(document.querySelectorAll('button, span, div')).find(node => {
                                        const t = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                                        return t === 'show qr' && node.getClientRects().length > 0;
                                    });
                                if (!el) return false;
                                el.click();
                                return true;
                            });

                            if (clickedQr) {
                                showQrDone = true;
                                console.log(`[${this.browserType} RAZORPAY] Show QR clicked successfully.`);
                                await this.delay(100);
                            }
                        }

                        // Step B: Click "Continue & Pay"
                        if (showQrDone && !continuePayDone) {
                            const clickedContinue = await frame.evaluate(() => {
                                const btn =
                                    document.querySelector('button[data-testid="fee-bearer-cta"]') ||
                                    Array.from(document.querySelectorAll('button')).find(b => {
                                        const t = (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                                        return (t.includes('continue & pay') || t.includes('continue and pay')) && !b.disabled;
                                    });
                                if (!btn) return false;
                                btn.click();
                                return true;
                            });

                            if (clickedContinue) {
                                continuePayDone = true;
                                console.log(`[${this.browserType} RAZORPAY] Continue & Pay clicked successfully.`);
                                break;
                            }
                        }
                    } catch (_) {
                        // Cross-origin or navigating frame, try next
                    }
                }
                if (showQrDone && continuePayDone) break;
            }

            // Agar QR image pehle hi screen par aa gayi hai toh loop rok dein
            if (showQrDone && !continuePayDone) {
                for (const p of targetPages) {
                    for (const frame of p.frames()) {
                        try {
                            const qrAlreadyVisible = await frame.evaluate(() => {
                                const img = document.querySelector('img[alt="UPI QR Code"], img[alt*="qr" i]');
                                return !!(img && img.complete && img.naturalWidth >= 100);
                            });
                            if (qrAlreadyVisible) {
                                continuePayDone = true;
                                break;
                            }
                        } catch (_) {}
                    }
                }
            }
        } catch (err) {
            console.warn(`[${this.browserType} RAZORPAY] Scan retry:`, err.message);
        }

        if (!showQrDone || !continuePayDone) {
            await this.delay(80);
        }
    }
}

this.sendBookingStatus(
    'QR DETECTING...',
    'QR DETECTING',
    78
);
console.log('\n================ AUTOMATION LOGS ===============');
if (result && result.logs) {
    result.logs.forEach(function(log) {
        console.log('  -> ' + log);
    });
}
console.log('================================================\n');
// FINAL RESULT
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
    // 5. BOOKING PAYMENT INITIALIZATION (SKIPPED/HANDLED IN STEP 4)
    async bookingInitPayment(bookingData, clientTransactionId, totalAmount = null, bankId = 113) {
    await this.delay(300);
    return {
        status: 200,
        success: true,
        message: 'Payment page and QR code successfully triggered.'
    };
}
    // SAFE BOOKING RESPONSE SUMMARY (no credentials/payment tokens)
logBookingResponse(stage, responseData, httpStatus = null) {
        const data = responseData && typeof responseData === 'object' ? responseData : {};
        const summary = {
            browserType: this.browserType,
            stage: String(stage || 'BOOKING'),
            httpStatus: Number.isFinite(Number(httpStatus)) ? Number(httpStatus) : null,
            success: typeof data.success === 'boolean' ? data.success : null,
            status: data.status || data.statusMessage || null,
            errorCode: data.errorCode || data.code || null,
            hasPnr: Boolean(data.pnr || data.PNR || data.reservationId),
            timestamp: new Date().toISOString()
        };
        console.log('[BOOKING RESPONSE SUMMARY]', JSON.stringify(summary));
        // Mini window / UI status update yahan se hata diya gaya hai
        return summary;
    }
    // VERIFY PAYMENT
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
        this.logBookingResponse('PAYMENT VERIFICATION', data, response.status);
console.log(
    '[PAYMENT VERIFY] Response received (sensitive fields omitted from summary).',
    data && typeof data === 'object' ? Object.keys(data) : typeof data
);
        if (data === null) {
            throw new Error('Payment verification response empty hai.');
        }
        return data;
    }
// BOOKING INPUT VALIDATION + DUPLICATE GUARD
validateBookingFormData(bookingData) {
    if (!bookingData || typeof bookingData !== 'object' || Array.isArray(bookingData)) {
        throw new Error('Booking data invalid hai.');
    }
    const trainNo = String(bookingData.trainNo || bookingData.trainNumber || '').trim();
    const fromStation = String(bookingData.fromStation || bookingData.from || '').trim();
    const toStation = String(bookingData.toStation || bookingData.to || '').trim();
    const journeyDate = String(bookingData.journeyDate || bookingData.date || '').trim();
    const trainClass = String(bookingData.trainClass || bookingData.classType || bookingData.class || '').trim();
    const quota = String(bookingData.quota || '').trim();
    const errors = [];
    if (!/^\d{4,6}$/.test(trainNo)) errors.push('Train number missing/invalid hai.');
    if (!fromStation) errors.push('From station missing hai.');
    if (!toStation) errors.push('To station missing hai.');
    if (fromStation && toStation && fromStation.toLowerCase() === toStation.toLowerCase()) {
        errors.push('From aur To station same nahi ho sakte.');
    }
    if (!/^(\d{8}|\d{4}-\d{2}-\d{2})$/.test(journeyDate)) {
        errors.push('Journey date missing/invalid hai.');
    } else {
        const normalizedDate = journeyDate.replace(/-/g, '');
        const year = Number(normalizedDate.slice(0, 4));
        const month = Number(normalizedDate.slice(4, 6));
        const day = Number(normalizedDate.slice(6, 8));
        const parsedDate = new Date(Date.UTC(year, month - 1, day));
        if (
            parsedDate.getUTCFullYear() !== year ||
            parsedDate.getUTCMonth() !== month - 1 ||
            parsedDate.getUTCDate() !== day
        ) {
            errors.push('Journey date calendar ke hisaab se valid nahi hai.');
        }
    }
    if (!trainClass) errors.push('Travel class missing hai.');
    if (!quota) errors.push('Quota missing hai.');
    if (Array.isArray(bookingData.passengers)) {
        if (bookingData.passengers.length > 6) {
            errors.push('Maximum 6 passengers allowed hain.');
        }
        bookingData.passengers.forEach((passenger, index) => {
            const row = index + 1;
            if (!passenger || typeof passenger !== 'object') {
                errors.push(`Passenger ${row}: details invalid hain.`);
                return;
            }
            const name = String(passenger.name || passenger.passengerName || '').trim();
            const ageValue = passenger.age ?? passenger.passengerAge;
            const age = Number(ageValue);
            const gender = String(passenger.gender || passenger.passengerGender || '').trim();
            if (!name) errors.push(`Passenger ${row}: name missing hai.`);
            if (ageValue === undefined || ageValue === null || String(ageValue).trim() === '' || !Number.isInteger(age) || age < 0 || age > 125) {
                errors.push(`Passenger ${row}: age 0 se 125 ke beech valid number hona chahiye.`);
            }
            if (!gender) errors.push(`Passenger ${row}: gender missing hai.`);
        });
    }
    if (errors.length) {
        this.sendBookingStatus(
            'Booking form validation failed: ' + errors.join(' | '),
            'FORM VALIDATION',
            5
        );
        throw new Error('Booking form validation failed: ' + errors.join(' '));
    }
    return { trainNo, fromStation, toStation, journeyDate, trainClass, quota };
}
createBookingFingerprint(bookingData) {
    const passengers = Array.isArray(bookingData.passengers)
        ? bookingData.passengers.map(p => ({
            name: String(p?.name || p?.passengerName || '').trim().toLowerCase(),
            age: String(p?.age ?? p?.passengerAge ?? ''),
            gender: String(p?.gender || p?.passengerGender || '').trim().toUpperCase()
        }))
        : [];
    return JSON.stringify({
        browser: this.browserType,
        trainNo: String(bookingData.trainNo || bookingData.trainNumber || '').trim(),
        from: String(bookingData.fromStation || bookingData.from || '').trim().toUpperCase(),
        to: String(bookingData.toStation || bookingData.to || '').trim().toUpperCase(),
        date: String(bookingData.journeyDate || bookingData.date || '').replace(/-/g, ''),
        trainClass: String(bookingData.trainClass || bookingData.classType || bookingData.class || '').trim().toUpperCase(),
        quota: String(bookingData.quota || '').trim().toUpperCase(),
        passengers
    });
}
// Public entry: validate and prevent concurrent duplicate submission.
async bookTicket(bookingData) {
    if (bookingData && bookingData.automationData) {
        bookingData = bookingData.automationData;
    }
    this.validateBookingFormData(bookingData);
    const fingerprint = this.createBookingFingerprint(bookingData);
    if (activeBookingLocks.has(fingerprint)) {
        this.sendBookingStatus(
            'Same booking request already in progress. Duplicate submission blocked.',
            'DUPLICATE REQUEST',
            5
        );
        throw new Error('Duplicate booking request blocked: identical booking is already running in this browser session.');
    }
    activeBookingLocks.add(fingerprint);
    this.sendBookingStatus('Booking details validated. Booking flow starting...', 'VALIDATION', 8);
    try {
        return await this._bookTicketUnlocked(bookingData);
    } finally {
        activeBookingLocks.delete(fingerprint);
        console.log(`[BOOKING LOCK] Released for ${this.browserType}.`);
    }
}
// Original booking implementation preserved below.
async _bookTicketUnlocked(bookingData) {
    console.log(
        '[API] bookTicket() called for External Browser.'
    );
    // UNWRAP AUTOMATION DATA FIRST
    if (
        bookingData &&
        bookingData.automationData
    ) {
        bookingData =
            bookingData.automationData;
    }
// Keep the correct booking status window ID
this.winId = String(bookingData?.winId || '').trim();
console.log(
    '[PROGRESS WINDOW] winId =',
    this.winId || '(missing)'
);
    // BASIC VALIDATION
    if (!bookingData || typeof bookingData !== 'object') {
        throw new Error(
            'Booking data invalid hai.'
        );
    }
    // AUTO LOGIN CREDENTIALS
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
    // CREDENTIALS REQUIRED
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
    // PUPPETEER PAGE CHECK
    if (!this.page || this.page.isClosed()) {
        throw new Error(
            `[${this.browserType}] Puppeteer page available nahi hai.`
        );
    }
    // JOURNEY DATE
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
// CAPTURE IRCTC ACCESS TOKEN DURING LOGIN
this.irctcAccessToken = "";
let resolveTokenCapture;
const tokenCapturePromise = new Promise(resolve => {
    resolveTokenCapture = resolve;
});
const tokenResponseHandler = async (response) => {
    try {
        const responseUrl = new URL(response.url());
        if (
            responseUrl.origin !== "https://www.irctc.co.in" ||
            responseUrl.pathname !== "/authprovider/webtoken" ||
            response.request().method() !== "POST"
        ) {
            return;
        }
        if (!response.ok()) return;
        const data = await response.json();
        if (
            typeof data?.access_token === "string" &&
            data.access_token.trim()
        ) {
            this.irctcAccessToken = data.access_token.trim();
            resolveTokenCapture(true);
            console.log("[AUTH] IRCTC access token captured successfully.");
            console.log(
                "[AUTH] Token expiry:",
                data.expires_in || "unknown",
                "seconds"
            );
        }
    } catch (error) {
        console.warn("[AUTH] Token capture error:", error.message);
    }
};
this.page.on("response", tokenResponseHandler);
try {
   
    
// PRE-LOGIN AVAILABILITY & FARE
// Existing availability check ko unchanged rakha gaya hai.
await this.checkPreLoginAvailabilityFromUI(bookingData);

// RESTORE SAVED SESSION IF NEEDED
await this.autoRestoreSession();

// EXISTING AUTO LOGIN / SESSION CHECK
await this.autoLogin(username, password);


    // Existing session mein naya /webtoken response nahi aayega.
    // Aise case mein current browser storage se JWT reuse karein.
    const tokenCaptured = await Promise.race([
        tokenCapturePromise,
        this.delay(8000).then(() => false)
    ]);

    if (!tokenCaptured) {
        const storedToken = await this.getBrowserJwtToken();
        if (storedToken) {
            const tokenStatus = this.inspectJwtExpiry(storedToken);
            if (tokenStatus.expired === true) {
                throw new Error(
                    `[${this.browserType}] Existing IRCTC browser JWT expired hai. Browser mein dobara login karein.`
                );
            }
            this.irctcAccessToken = storedToken;
            console.log(
                "[AUTH] Existing browser JWT reused. Expiry:",
                tokenStatus.expired === false ? "valid" : "unknown"
            );
        } else {
            console.warn(
                "[AUTH] Existing-session token browser storage mein nahi mila."
            );
        }
    }

    console.log(
        "[AUTH] Access token captured from network:",
        tokenCaptured
    );
} finally {
    this.page.off("response", tokenResponseHandler);
}
try {
    console.log('[API] Starting complete booking sequence flow...');
        const dynamicTxnId =
            this.generateTransactionId();
        bookingData.dynamicTxnId =
            dynamicTxnId;
// STEP 1: Custom fetch API skip (Availability aur Fare ab seedha live DOM se read hoga taaki HTTP 409/401 na aaye)
            console.log('[SAFE MODE] Reading Availability & Fare directly from UI DOM (prevents HTTP 409/401).');
            // STEP 3: Master Passengers List (Sirf tab chalega jab form se passenger nahi aaye honge)
            if (!Array.isArray(bookingData.passengers) || bookingData.passengers.length === 0) {
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
                } else {
                    throw new Error('Master list empty hai aur form mein bhi koi passenger nahi mila.');
                }
            }
            // STEP 4: Full Automated UI Flow
            const stepResult = await this.finalFareAndPassengerEnquiry(bookingData);
            this.logBookingResponse('BOOKING PAGE FLOW', stepResult, stepResult?.status);
            if (!stepResult || !stepResult.success) {
                throw new Error('Automated booking flow failed.');
            }
// QR recovery mein pehle hi handle ho chuka hai.
// Yahan UPI/QR buttons dobara click nahi karne hain.
if (
    String(
        bookingData.payment ||
        bookingData.paymentType ||
        bookingData.paymentMethod ||
        ''
    ).trim().toUpperCase().startsWith('IPAY')
) {
    console.log(
        '[IPAY] Existing QR verify kar rahe hain. ' +
        'UPI/QR buttons dobara click nahi honge.'
    );
    await this.page.waitForFunction(
        () => {
            const canvas = document.querySelector(
                '#irctcDynamicQrCanvas'
            );
            if (!canvas || !canvas.isConnected) {
                return false;
            }
            const rect = canvas.getBoundingClientRect();
            return (
                rect.width >= 100 &&
                rect.height >= 100 &&
                canvas.width >= 100 &&
                canvas.height >= 100
            );
        },
        { timeout: 15000 }
    );
    console.log(
        '[IPAY] Existing QR canvas verified. No extra click.'
    );
}
console.log('[QR] Waiting for payment page to load...');
var paymentValue = String(
    bookingData.payment ||
    bookingData.paymentType ||
    bookingData.paymentMethod ||
    ''
).trim().toUpperCase();
var qrSelector = null;
if (paymentValue.startsWith('PAYTM')) {
    qrSelector = 'img[data-key="qr-code"]';
} else if (paymentValue.startsWith('PHONEPE')) {
    qrSelector =
        'img[src*="qr" i], img[alt*="qr" i], img[src^="blob:"], canvas';
} else if (paymentValue.startsWith('RAZORPAY')) {
    qrSelector =
        'img[src*="qr" i], img[alt*="qr" i], canvas';
}
if (!qrSelector) {
    throw new Error(
        'QR selector payment ke liye available nahi hai: ' +
        paymentValue
    );
}
try {
    if (!paymentValue.startsWith('RAZORPAY')) {
        await this.page.waitForFunction(
            selector => {
                const elements = Array.from(
                    document.querySelectorAll(selector)
                );
                return elements.some(el => {
                    const rect = el.getBoundingClientRect();
                    if (
                        rect.width < 100 ||
                        rect.height < 100
                    ) {
                        return false;
                    }
                    if (el instanceof HTMLImageElement) {
                        return (
                            el.complete &&
                            el.naturalWidth >= 100 &&
                            el.naturalHeight >= 100
                        );
                    }
                    if (el instanceof HTMLCanvasElement) {
                        return (
                            el.width >= 100 &&
                            el.height >= 100
                        );
                    }
                    return false;
                });
            },
            { timeout: 60000 },
            qrSelector
        );
    }
} catch (e) {
    throw new Error(
        paymentValue +
        ' ka loaded QR 60 seconds mein nahi mila: ' +
        e.message
    );
}
console.log(
    '[QR] ' +
    paymentValue +
    ' QR detected successfully.'
);
// SEND SAME QR + LIVE IRCTC TIMER
// TO MINI WINDOW
try {
    let qrImage = null;
    let qrElement = null;
    let qrReady = Boolean(this._instantRazorpaySent);
    // WAIT FOR QR TO ACTUALLY LOAD (Skip if already pushed at 0ms)
    const qrDeadline = this._instantRazorpaySent ? 0 : (Date.now() + 60000);
    while (Date.now() < qrDeadline) {
        try {
            if (!this.page || this.page.isClosed()) {
                throw new Error('Payment page closed.');
            }
          if (paymentValue.startsWith('PAYTM')) {
                qrElement = await this.page.$(
                    'img[data-key="qr-code"]'
                );
                if (qrElement) {
                    const imageInfo = await qrElement.evaluate(el => ({
                        complete: el.complete,
                        width: el.naturalWidth,
                        height: el.naturalHeight,
                        src: el.currentSrc || el.src || ''
                    }));
                    if (
                        imageInfo.complete &&
                        imageInfo.width >= 100 &&
                        imageInfo.height >= 100
                    ) {
                        if (
                            imageInfo.src.startsWith('data:image/')
                        ) {
                            qrImage = imageInfo.src;
                        } else {
                            const base64 =
                                await qrElement.screenshot({
                                    encoding: 'base64'
                                });
                            if (base64 && base64.length > 2000) {
                                qrImage =
                                    'data:image/png;base64,' + base64;
                            }
                        }
                        qrReady = !!qrImage;
                    }
                }
            } else if (paymentValue.startsWith('PHONEPE')) {
                const candidates = await this.page.$$(
                    'img[src*="qr" i], img[alt*="qr" i], img[src^="blob:"], canvas'
                );
                for (const candidate of candidates) {
                    const info = await candidate.evaluate(el => {
                        const rect = el.getBoundingClientRect();
                        return {
                            tag: el.tagName,
                            visible:
                                rect.width >= 100 &&
                                rect.height >= 100,
                            complete:
                                el instanceof HTMLImageElement
                                    ? el.complete
                                    : true,
                            width:
                                el instanceof HTMLImageElement
                                    ? el.naturalWidth
                                    : el.width,
                            height:
                                el instanceof HTMLImageElement
                                    ? el.naturalHeight
                                    : el.height,
                            src:
                                el instanceof HTMLImageElement
                                    ? (el.currentSrc || el.src || '')
                                    : ''
                        };
                    });
                    if (
                        !info.visible ||
                        !info.complete ||
                        info.width < 100 ||
                        info.height < 100
                    ) {
                        continue;
                    }
                    if (info.tag === 'CANVAS') {
                        qrImage = await candidate.evaluate(
                            el => el.toDataURL('image/png')
                        );
                    } else {
                        if (info.src.startsWith('data:image/png;base64,')) {
    // Original Razorpay PNG ko bina screenshot ke use karo
    qrImage = info.src;
} else if (info.tag === 'IMG') {
    // Original image resolution par PNG banane ki koshish
    qrImage = await candidate.evaluate(el => {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = el.naturalWidth;
            canvas.height = el.naturalHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(el, 0, 0, el.naturalWidth, el.naturalHeight);
            return canvas.toDataURL('image/png');
        } catch (_) {
            return null;
        }
    });
    // Fallback: existing screenshot method
    if (!qrImage) {
        const base64 = await candidate.screenshot({
            encoding: 'base64'
        });
        if (base64 && base64.length > 2000) {
            qrImage = 'data:image/png;base64,' + base64;
        }
    }
}
}
if (
    qrImage &&
    qrImage.startsWith('data:image/') &&
    qrImage.length > 2000
) {
    qrElement = candidate;
    qrReady = true;
    break;
}
                    qrImage = null;
                }
            } else if (paymentValue.startsWith('RAZORPAY')) {
                // Razorpay hosted page ko directly scan karo.
                const browserPages = await this.page.browser().pages();
                for (const candidatePage of browserPages) {
                    if (
                        candidatePage.isClosed() ||
                        !candidatePage.url().startsWith(
                            'https://checkout-hosted.razorpay.com/orders/'
                        )
                    ) {
                        continue;
                    }
                    for (const frame of candidatePage.frames()) {
                        let candidates = [];
                        const rankedCandidates = [];
try {
    candidates = await frame.$$(
        'img[alt="UPI QR Code"], ' +
        'img[alt*="qr" i], ' +
        'img[src*="qr" i], ' +
        'img[src^="blob:"], ' +
        'img[src^="data:image/"], ' +
        'canvas'
    );
                            // Candidate details parallel mein lo, ek-ek karke nahi.
                            const infos = await Promise.all(
                                candidates.map(async candidate => {
                                    try {
                                        return await candidate.evaluate(el => {
                                            const rect = el.getBoundingClientRect();
                                            const style = getComputedStyle(el);
                                            const isImg = el instanceof HTMLImageElement;
                                            const isCanvas = el instanceof HTMLCanvasElement;
                                            const width = isImg
                                                ? el.naturalWidth
                                                : (isCanvas ? el.width : 0);
                                            const height = isImg
                                                ? el.naturalHeight
                                                : (isCanvas ? el.height : 0);
                                            return {
                                                tag: el.tagName,
                                                visible:
                                                    rect.width >= 100 &&
                                                    rect.height >= 100 &&
                                                    style.display !== 'none' &&
                                                    style.visibility !== 'hidden' &&
                                                    Number(style.opacity) !== 0,
                                                complete: isImg ? el.complete : true,
                                                width,
                                                height,
                                                src: isImg
                                                    ? (el.currentSrc || el.src || '')
                                                    : '',
                                                square:
                                                    width > 0 &&
                                                    height > 0 &&
                                                    width / height >= 0.75 &&
                                                    width / height <= 1.25
                                            };
                                        });
                                    } catch (_) {
                                        return null;
                                    }
                                })
                            );
                            for (let i = 0; i < infos.length; i++) {
                                const info = infos[i];
                                if (
                                    info &&
                                    info.visible &&
                                    info.complete &&
                                    info.square &&
                                    info.width >= 100 &&
                                    info.height >= 100
                                ) {
                                    rankedCandidates.push({
                                        candidate: candidates[i],
                                        info
                                    });
                                }
                            }
                            // Highest native resolution QR first.
                            rankedCandidates.sort((a, b) =>
                                (b.info.width * b.info.height) -
                                (a.info.width * a.info.height)
                            );
                            for (const item of rankedCandidates) {
                                const candidate = item.candidate;
                                const info = item.info;
                                let candidateImage = null;
                                try {
                                    if (
                                        info.tag === 'IMG' &&
                                        info.src.startsWith('data:image/')
                                    ) {
                                        // Original image data: no resize.
                                        candidateImage = info.src;
                                    } else if (info.tag === 'CANVAS') {
                                        // PhonePe jaisa original canvas export.
                                        candidateImage = await candidate.evaluate(
                                            el => el.toDataURL('image/png')
                                        );
                                    } else if (info.tag === 'IMG') {
                                        // Original intrinsic dimensions par HD conversion.
                                        candidateImage = await candidate.evaluate(el => {
                                            try {
                                                const canvas =
                                                    document.createElement('canvas');
                                                canvas.width = el.naturalWidth;
                                                canvas.height = el.naturalHeight;
                                                const ctx = canvas.getContext('2d');
                                                if (
                                                    !ctx ||
                                                    !canvas.width ||
                                                    !canvas.height
                                                ) {
                                                    return null;
                                                }
                                                ctx.drawImage(
                                                    el,
                                                    0,
                                                    0,
                                                    el.naturalWidth,
                                                    el.naturalHeight
                                                );
                                                return canvas.toDataURL('image/png');
                                            } catch (_) {
                                                return null;
                                            }
                                        });
                                        // Fast Blob-to-Base64 inside frame (avoids Chromium iframe screenshot hang)
                                        if (!candidateImage && info.src && info.src.startsWith('blob:')) {
                                            candidateImage = await candidate.evaluate(async (el) => {
                                                try {
                                                    const res = await fetch(el.currentSrc || el.src);
                                                    const blob = await res.blob();
                                                    return await new Promise((resolve) => {
                                                        const reader = new FileReader();
                                                        reader.onloadend = () => resolve(reader.result);
                                                        reader.onerror = () => resolve(null);
                                                        reader.readAsDataURL(blob);
                                                    });
                                                } catch (_) {
                                                    return null;
                                                }
                                            });
                                        }

                                        // Last resort screenshot with strict 2-second timeout so it never hangs 3 mins
                                        if (!candidateImage) {
                                            const base64 = await Promise.race([
                                                candidate.screenshot({ encoding: 'base64' }),
                                                new Promise(resolve => setTimeout(() => resolve(null), 2000))
                                            ]);
                                            if (base64 && base64.length > 2000) {
                                                candidateImage = 'data:image/png;base64,' + base64;
                                            }
                                        }
                                    }
                                    if (
                                        candidateImage &&
                                        candidateImage.startsWith('data:image/') &&
                                        candidateImage.length > 2000
                                    ) {
                                        qrImage = candidateImage;
                                        qrElement = candidate;
                                        qrReady = true;
                                        break;
                                    }
                                } catch (captureError) {
                                    console.warn(
                                        '[RAZORPAY QR] Capture failed:',
                                        captureError.message
                                    );
                                }
                            }
                        } catch (frameError) {
                            console.warn(
                                '[RAZORPAY QR] Frame scan failed:',
                                frameError.message
                            );
                        } finally {
                            for (const candidate of candidates) {
                                if (candidate !== qrElement) {
                                    try {
                                        await candidate.dispose();
                                    } catch (_) {}
                                }
                            }
                        }
                        if (qrReady) break;
                    }
                    if (qrReady) break;
                }
            }
            if (qrReady && qrImage) {
                console.log(
                    '[QR] Loaded QR image ready:',
                    paymentValue
                );
                break;
            }
        } catch (attemptError) {
            console.warn(
                '[QR] Waiting for QR:',
                attemptError.message
            );
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!qrReady || !qrImage) {
        throw new Error(
            paymentValue +
            ' QR 60 seconds mein load nahi hua. Blank popup nahi bheja gaya.'
        );
    }

   // INSTANT DISPLAY WITH EXACT RAZORPAY AMOUNT & TIMER (WEB / WEB2 / WEB3 / WEB4)
    if (
        qrImage &&
        this.win &&
        !this.win.isDestroyed() &&
        this.qrCallbacks &&
        typeof this.qrCallbacks.showQR === 'function'
    ) {
        let instantTimer = null;
        let instantAmount = null;

        if (paymentValue.startsWith('RAZORPAY')) {
            try {
                const browserPages = await this.page.browser().pages();
                for (const candidatePage of browserPages) {
                    if (
                        candidatePage.isClosed() ||
                        !candidatePage.url().startsWith('https://checkout-hosted.razorpay.com/orders/')
                    ) {
                        continue;
                    }
                    // Sabhi frames ko ek saath (parallel) scan karein taaki 0 delay rahe
                    await Promise.all(
                        candidatePage.frames().map(async (frame) => {
                            try {
                                const meta = await frame.evaluate(() => {
                                    let foundTimer = null;
                                    let foundAmount = null;

                                    // 1. Exact Razorpay Timer (MM:SS)
                                    for (const el of document.querySelectorAll('span')) {
                                        const text = String(el.innerText || '').trim();
                                        if (/^\d{1,2}:\d{2}$/.test(text)) {
                                            const [m, s] = text.split(':').map(Number);
                                            if (m >= 0 && m <= 60 && s >= 0 && s <= 59) {
                                                foundTimer = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
                                                break;
                                            }
                                        }
                                    }

                                    // 2. Exact Razorpay Amount (summary-amount)
                                    const amountEl = document.querySelector('h3[data-testid="summary-amount"]');
                                    if (amountEl) {
                                        const val = amountEl.getAttribute('data-value');
                                        if (val && /^\d+$/.test(val)) {
                                            foundAmount = (Number(val) / 100).toFixed(2);
                                        } else {
                                            const raw = (amountEl.innerText || '').replace(/₹|Rs\.?/gi, '').replace(/[^\d,.]/g, '').trim();
                                            if (raw) foundAmount = raw;
                                        }
                                    }
                                    if (!foundAmount) {
                                        const fallbackEl = document.querySelector('[data-testid="summary-amount-fallback"]');
                                        if (fallbackEl) {
                                            const rawFb = (fallbackEl.innerText || fallbackEl.textContent || '').replace(/₹|Rs\.?/gi, '').replace(/[^\d,.]/g, '').trim();
                                            if (rawFb) foundAmount = rawFb;
                                        }
                                    }

                                    return { foundTimer, foundAmount };
                                });

                                if (meta.foundTimer && !instantTimer) instantTimer = meta.foundTimer;
                                if (meta.foundAmount && !instantAmount) instantAmount = meta.foundAmount;
                            } catch (_) {}
                        })
                    );
                }
            } catch (_) {}
        }

        this.qrCallbacks.showQR({
            image: qrImage,
            remainingTime: instantTimer || '00:00',
            paymentType: paymentValue,
            amount: instantAmount || bookingData.realFare || null
        });
        console.log('[QR] Instant Razorpay QR pushed | Timer:', instantTimer, '| Amount:', instantAmount);
    }

    // FIND LIVE IRCTC PAYMENT TIMER
let remainingTime = null;
try {
    const paymentValue = String(
        bookingData.payment ||
        bookingData.paymentType ||
        bookingData.paymentMethod ||
        ''
    ).trim().toUpperCase();
    if (paymentValue.startsWith('RAZORPAY')) {
        const browserPages = await this.page.browser().pages();
        for (const candidatePage of browserPages) {
            if (
                candidatePage.isClosed() ||
                !candidatePage.url().startsWith(
                    'https://checkout-hosted.razorpay.com/orders/'
                )
            ) {
                continue;
            }
            for (const frame of candidatePage.frames()) {
                try {
                    const timer = await frame.evaluate(() => {
                        const elements = Array.from(
                            document.querySelectorAll('span')
                        );
                        for (const element of elements) {
                            const text = String(
                                element.innerText || ''
                            ).trim();
                            if (!/^\d{1,2}:\d{2}$/.test(text)) {
                                continue;
                            }
                            const [minutes, seconds] =
                                text.split(':').map(Number);
                            if (
                                Number.isInteger(minutes) &&
                                Number.isInteger(seconds) &&
                                minutes >= 0 &&
                                minutes <= 60 &&
                                seconds >= 0 &&
                                seconds <= 59
                            ) {
                                return (
                                    String(minutes).padStart(2, '0') +
                                    ':' +
                                    String(seconds).padStart(2, '0')
                                );
                            }
                        }
                        return null;
                    });
                    if (timer) {
                        remainingTime = timer;
                        break;
                    }
                } catch (_) {
                    // Frame navigation ho to agla frame check karein.
                }
            }
            if (remainingTime) break;
        }
    } else {
        // Non-Razorpay payment methods ka existing timer logic.
        remainingTime = await this.page.evaluate(() => {
            const elements = Array.from(
                document.querySelectorAll('*')
            );
            for (const element of elements) {
                const text = String(
                    element.innerText || ''
                ).trim();
                const timerMatch = text.match(
    /^(\d{1,2})\s*min\s*:\s*(\d{1,2})\s*sec$/i
);
let minutes;
let seconds;
if (timerMatch) {
    minutes = Number(timerMatch[1]);
    seconds = Number(timerMatch[2]);
} else if (/^\d{1,2}:\d{2}$/.test(text)) {
    [minutes, seconds] = text.split(':').map(Number);
} else {
    continue;
}
                if (
                    Number.isInteger(minutes) &&
                    Number.isInteger(seconds) &&
                    minutes >= 0 &&
                    minutes <= 60 &&
                    seconds >= 0 &&
                    seconds <= 59
                ) {
                    return (
                        String(minutes).padStart(2, '0') +
                        ':' +
                        String(seconds).padStart(2, '0')
                    );
                }
            }
            return '00:00';
        });
    }
} catch (timerError) {
    console.warn(
        '[QR] Payment timer read failed:',
        timerError.message
    );
}
// READ ACTUAL PAYTM PAYMENT AMOUNT
let qrAmount = null;
try {
    const browserPages = await this.page.browser().pages();
    for (const candidatePage of browserPages) {
        if (candidatePage.isClosed()) continue;
        for (const frame of candidatePage.frames()) {
            try {
                const amountText = await frame.evaluate(() => {
                    const el = document.querySelector('.fr.xs-am');
                    if (!el) return null;
                    return el.innerText || el.textContent || '';
                });
                if (amountText) {
                    qrAmount = amountText
                        .replace(/Rs\s*/i, '')
                        .replace(/[^\d,.]/g, '')
                        .trim();
                    if (qrAmount) break;
                }
            } catch (_) {
                // Frame navigation ho to agla frame check karein.
            }
        }
        if (qrAmount) break;
    }
    console.log('[QR] Actual payment amount:', qrAmount || 'Not found');
} catch (amountError) {
    console.warn(
        '[QR] Payment amount read failed:',
        amountError.message
    );
}
    // SEND QR TO MINI WINDOW - FAST DISPLAY
    if (
        qrImage &&
        this.win &&
        !this.win.isDestroyed()
    ) {
        if (
            this.qrCallbacks &&
            typeof this.qrCallbacks.showQR === 'function'
        ) {
// READ PHONEPE / RAZORPAY PAYMENT AMOUNT
try {
    const browserPages = await this.page.browser().pages();
    for (const candidatePage of browserPages) {
        if (candidatePage.isClosed()) continue;
        for (const frame of candidatePage.frames()) {
            try {
                const amountText = await frame.evaluate((paymentType) => {
                    // PHONEPE
                    if (paymentType.startsWith('PHONEPE')) {
                        const el = document.querySelector('.dark1.mr3');
                        if (el) {
                            return el.innerText || el.textContent || null;
                        }
                    }
                    // RAZORPAY
if (paymentType.startsWith('RAZORPAY')) {
    const amountEl = document.querySelector(
        'h3[data-testid="summary-amount"]'
    );
    if (amountEl) {
        const value = amountEl.getAttribute('data-value');
        if (value && /^\d+$/.test(value)) {
            return (Number(value) / 100).toFixed(2);
        }
        // Fallback: hidden amount element
        const fallback = document.querySelector(
            '[data-testid="summary-amount-fallback"]'
        );
        if (fallback) {
            return fallback.innerText || fallback.textContent || null;
        }
    }
}
                    return null;
                }, paymentValue);
                if (amountText) {
                    qrAmount = amountText
                        .replace(/₹|Rs\.?/gi, '')
                        .replace(/[^\d,.]/g, '')
                        .trim();
                    if (qrAmount) break;
                }
            } catch (_) {
                // Frame load hone par next frame check karein.
            }
        }
        if (qrAmount) break;
    }
    console.log('[QR] Payment amount:', qrAmount || 'Not found');
} catch (amountError) {
    console.warn('[QR] Amount read failed:', amountError.message);
}
const qrPayload = {
    image: qrImage,
    remainingTime: remainingTime,
    paymentType: paymentValue,
    amount: qrAmount
};
            // Send immediately
            this.qrCallbacks.showQR(qrPayload);
            console.log(
                '[QR] QR sent immediately to mini window.'
            );
            // Quick backup resend
            setTimeout(() => {
                try {
                    if (
                        this.qrCallbacks &&
                        typeof this.qrCallbacks.showQR === 'function' &&
                        this.win &&
                        !this.win.isDestroyed()
                    ) {
                        this.qrCallbacks.showQR(qrPayload);
                        console.log(
                            '[QR] Quick backup QR resend sent.'
                        );
                    }
                } catch (error) {
                    console.warn(
                        '[QR] Backup resend failed:',
                        error.message
                    );
                }
            }, 200);
        } else {
            console.warn(
                '[QR] QR show callback available nahi hai.'
            );
        }
        console.log(
            '[QR] IRCTC payment timer:',
            remainingTime
        );
    } else {
        console.warn(
            '[QR] QR image ya mini window available nahi hai.'
        );
    }
} catch (qrPopupError) {
    console.warn(
        '[QR] Mini window QR popup preparation failed:',
        qrPopupError.message
    );
}
this.sendBookingStatus(
    'SCAN & PAY',
    'SCAN & PAY',
    80
);
console.log(
    '[PAYMENT] QR detected. Waiting for actual payment confirmation.'
);
// RAZORPAY LIVE TIMER UPDATER
if (paymentValue.startsWith('RAZORPAY')) {
    let razorpayTimerStopped = false;
    const razorpayTimerInterval = setInterval(async () => {
        try {
            if (
                razorpayTimerStopped ||
                !this.page ||
                this.page.isClosed() ||
                !this.win ||
                this.win.isDestroyed() ||
                !this.qrCallbacks ||
                typeof this.qrCallbacks.updateQRTimer !== 'function'
            ) {
                return;
            }
            const pages = await this.page.browser().pages();
            let remainingTime = null;
            for (const page of pages) {
                if (
                    page.isClosed() ||
                    !page.url().startsWith(
                        'https://checkout-hosted.razorpay.com/orders/'
                    )
                ) {
                    continue;
                }
                for (const frame of page.frames()) {
                    try {
                        const timer = await frame.evaluate(() => {
                            for (const el of document.querySelectorAll('span')) {
                                const text = (el.innerText || '').trim();
                                if (!/^\d{1,2}:\d{2}$/.test(text)) {
                                    continue;
                                }
                                const [m, s] = text.split(':').map(Number);
                                if (
                                    Number.isInteger(m) &&
                                    Number.isInteger(s) &&
                                    m >= 0 && m <= 60 &&
                                    s >= 0 && s <= 59
                                ) {
                                    return (
                                        String(m).padStart(2, '0') +
                                        ':' +
                                        String(s).padStart(2, '0')
                                    );
                                }
                            }
                            return null;
                        });
                        if (timer) {
                            remainingTime = timer;
                            break;
                        }
                    } catch (_) {
                        // Frame navigate ho to agle frame ko check karein.
                    }
                }
                if (remainingTime) break;
            }
            // Timer milne par hi update karo.
// Missing timer ko 00:00 mat bhejo.
if (
    remainingTime &&
    /^\d{2}:\d{2}$/.test(remainingTime) &&
    remainingTime !== '00:00'
) {
    this.qrCallbacks.updateQRTimer({
        remainingTime
    });
}
        } catch (error) {
            console.warn(
                '[QR] Razorpay timer update failed:',
                error.message
            );
        }
    }, 500);
    // Safety cleanup: 5 minutes baad interval band.
    setTimeout(() => {
        razorpayTimerStopped = true;
        clearInterval(razorpayTimerInterval);
    }, 300000);
}
// WAIT FOR PAYMENT BEFORE VERIFICATION
this.sendBookingStatus(
    'SCAN & PAY',
    'SCAN & PAY',
    85
);
console.log(
    '[PAYMENT] QR detected. User payment complete karein.'
);
// Payment verification ko QR detect hote hi immediately call nahi karna.
// Pehle payment page ko success/confirmation state mein aane denge.
let paymentCompleted = false;
let paymentFailed = false;
let confirmedPagePNR = null;
// Payment confirmation ke liye maximum 5 minutes.
const paymentConfirmationDeadline = Date.now() + (5 * 60 * 1000);
for (
    let i = 0;
    Date.now() < paymentConfirmationDeadline;
    i++
) {
    let paymentState = {
        success: false,
        failed: false,
        remainingTime: '00:00'
    };
    try {
        if (!this.page || this.page.isClosed()) {
            throw new Error('Payment page closed.');
        }
await new Promise(function(resolve) {
    setTimeout(resolve, 300);
});
paymentState = await this.page.evaluate(() => {
    const url = window.location.href.toLowerCase();
    const bodyText = String(
        document.body?.innerText || ''
    );
    const body = bodyText.toLowerCase();
const bookingConfirmPage =
    url.includes('/nget/booking-confirm');
// PNR ko label ke saath identify karein.
// Random 10-digit number ko PNR na maanein.
const pnrMatch = bodyText.match(
    /\bPNR(?:\s*(?:Number|No\.?))?\s*[:#-]?\s*([0-9]{10})\b/i
);
const pnr = pnrMatch ? pnrMatch[1] : null;
// Confirmation URL par pahunchna hi confirmation
// page detect karne ke liye kaafi hai.
// PNR alag se extract kiya jayega.
const bookingConfirmed = bookingConfirmPage;
const success =
    bookingConfirmed ||
    body.includes('payment successful') ||
    body.includes('payment success') ||
    body.includes('payment completed') ||
    body.includes('transaction successful') ||
    body.includes('transaction completed');
    const failed =
        !bookingConfirmed &&
        (
            body.includes('payment failed') ||
            body.includes('transaction failed') ||
            body.includes('payment failure')
        );
        // READ LIVE PAYMENT TIMER
        // Supports both MM:SS and "06 min : 46 sec"
        let remainingTime = '00:00';
        const elements = Array.from(
            document.querySelectorAll('*')
        );
        for (const element of elements) {
            const text = String(
                element.innerText || ''
            ).trim();
            let minutes;
            let seconds;
            // Format: 06 min : 46 sec
            const timerMatch = text.match(
                /^(\d{1,2})\s*min\s*:\s*(\d{1,2})\s*sec$/i
            );
            // Format: 06:46
            if (timerMatch) {
                minutes = Number(timerMatch[1]);
                seconds = Number(timerMatch[2]);
            } else if (/^\d{1,2}:\d{2}$/.test(text)) {
                const parts = text.split(':');
                minutes = Number(parts[0]);
                seconds = Number(parts[1]);
            } else {
                continue;
            }
            if (
                Number.isInteger(minutes) &&
                Number.isInteger(seconds) &&
                minutes >= 0 &&
                minutes <= 60 &&
                seconds >= 0 &&
                seconds <= 59
            ) {
                remainingTime =
                    String(minutes).padStart(2, '0') +
                    ':' +
                    String(seconds).padStart(2, '0');
                break;
            }
        }
        return {
            success,
            failed,
            remainingTime,
            bookingConfirmed,
            pnr,
            url
        };
    });
    } catch (e) {
        const errorMessage =
            String(
                e?.message || ''
            );
        console.warn(
            '[PAYMENT] Payment status read failed:',
            errorMessage
        );
        await new Promise(function(resolve) {
            setTimeout(resolve, 500);
        });
        continue;
    }
    // LIVE QR TIMER UPDATE
    try {
        if (
            !paymentValue.startsWith('RAZORPAY') &&
            this.qrCallbacks &&
            typeof this.qrCallbacks.updateQRTimer === 'function'
        ) {
            this.qrCallbacks.updateQRTimer({
                remainingTime: paymentState.remainingTime
            });
        }
    } catch (timerUpdateError) {
        console.warn(
            '[QR] Live payment timer update failed:',
            timerUpdateError.message
        );
    }
    // PAYMENT SUCCESS
    if (paymentState.success) {
        paymentCompleted = true;
        confirmedPagePNR = paymentState.pnr || null;
        try {
            if (
                this.qrCallbacks &&
                typeof this.qrCallbacks.hideQR === 'function'
            ) {
                this.qrCallbacks.hideQR();
                console.log(
                    '[QR] Payment successful. Separate QR window closed.'
                );
            }
        } catch (qrHideError) {
            console.warn(
                '[QR] QR popup hide failed:',
                qrHideError.message
            );
        }
        break;
    }
    // PAYMENT FAILURE
    if (paymentState.failed) {
        paymentFailed = true;
        try {
            if (
                this.qrCallbacks &&
                typeof this.qrCallbacks.hideQR === 'function'
            ) {
                this.qrCallbacks.hideQR();
                console.log(
                    '[QR] Payment failed. Separate QR window closed.'
                );
            }
        } catch (qrHideError) {
            console.warn(
                '[QR] QR popup hide failed:',
                qrHideError.message
            );
        }
        break;
    }
    // NEXT PAYMENT CHECK
    await new Promise(function(resolve) {
        setTimeout(resolve, 1000);
    });
}
if (paymentFailed) {
    this.sendProgress(
        'PAYMENT FAILED',
        'Payment failed.',
        0
    );
    throw new Error(
        'Payment failed. Confirmation page ne failure indicate kiya.'
    );
}
if (!paymentCompleted) {
    try {
        if (
            this.qrCallbacks &&
            typeof this.qrCallbacks.hideQR === 'function'
        ) {
            this.qrCallbacks.hideQR();
            console.log(
                '[QR] Payment confirmation timeout. Separate QR window closed.'
            );
        }
    } catch (qrHideError) {
        console.warn(
            '[QR] QR popup hide failed on timeout:',
            qrHideError.message
        );
    }
    this.sendProgress(
        'PAYMENT FAILED',
        'Payment confirmation timeout. Payment success confirm nahi hui.',
        0
    );
    throw new Error(
        'Payment confirmation timeout. Payment success confirm nahi hui.'
    );
}
console.log(
    '[PAYMENT] Payment success state detected.'
);
this.sendBookingStatus(
    'PAYMENT RECEIVED',
    'PAYMENT RECEIVED',
    90
);
console.log(
    '[PAYMENT] Success detected. Waiting for IRCTC navigation to settle before verification...'
);
await new Promise(function(resolve) {
    setTimeout(resolve, 1500);
});
console.log(
    '[PAYMENT] Starting payment verification...'
);
// VERIFY PAYMENT / GET PNR
const clientTransactionId =
    stepResult.clientTransactionId ||
    stepResult.data?.clientTransactionId ||
    bookingData.clientTransactionId;
const totalAmount =
    bookingData.realFare ||
    stepResult.totalFare ||
    stepResult.data?.totalFare;
if (!clientTransactionId) {
    console.log(
        '[PAYMENT VERIFY] Transaction ID missing; checking the payment confirmation page for PNR.'
    );
    let pagePNR =
        confirmedPagePNR &&
        /^\d{10}$/.test(String(confirmedPagePNR))
            ? String(confirmedPagePNR)
            : null;
    // Use the SAME Puppeteer page used by the payment loop.
    // Do not close or click the feedback popup.
    for (let attempt = 1; attempt <= 15 && !pagePNR; attempt++) {
        try {
            if (!this.page || this.page.isClosed()) {
                console.warn('[PNR] Payment page is not available.');
                break;
            }
            const result = await this.page.evaluate(() => {
                const url = window.location.href;
                const text = [
                    document.body?.innerText || '',
                    document.body?.textContent || ''
                ].join('\n');
                const match = text.match(
                    /\bPNR\s*(?:Number|No\.?)?\s*[:#-]?\s*([0-9]{10})\b/i
                );
                return {
                    url,
                    pnr: match ? match[1] : null
                };
            });
            if (attempt === 1) {
                console.log('[PNR] Confirmation check URL:', result.url);
            }
            if (result.pnr && /^\d{10}$/.test(String(result.pnr))) {
                pagePNR = String(result.pnr);
                confirmedPagePNR = pagePNR;
                console.log('[PNR] PNR detected on payment page.');
                break;
            }
        } catch (e) {
            console.warn(
                '[PNR] Read attempt failed:',
                attempt,
                e.message
            );
        }
        if (!pagePNR) {
            await this.delay(1000);
        }
    }
    if (pagePNR) {
        console.log('[BOOKING] PNR found:', pagePNR);
        this.sendBookingStatus(
            'BOOKING CONFIRMED',
            'PNR: ' + pagePNR,
            100
        );
        return {
            success: true,
            supported: true,
            pnr: pagePNR,
            data: stepResult,
            payment: null
        };
    }
    throw new Error(
        'Transaction ID nahi mili aur payment page par labelled PNR nahi mila. IRCTC booking status verify karein.'
    );
}
if (
    totalAmount === null ||
    totalAmount === undefined ||
    String(totalAmount).trim() === ''
) {
    throw new Error(
        'Payment verification ke liye total fare nahi mila.'
    );
}
const paymentResult =
    await this.verifyPaymentAndGetPNR(
        clientTransactionId,
        totalAmount
    );
console.log(
    '[PAYMENT] Verification response received.'
);
const paymentText =
    JSON.stringify(
        paymentResult || {}
    ).toLowerCase();
 // RETRY PNR EXTRACTION FROM CONFIRMATION PAGE
 // Feedback popup ko close nahi karna hai.
for (let attempt = 1; attempt <= 15; attempt++) {
    if (
        confirmedPagePNR &&
        /^\d{10}$/.test(String(confirmedPagePNR))
    ) {
        break;
    }
    try {
        if (this.page && !this.page.isClosed()) {
            const pagePNR = await this.page.evaluate(() => {
                const text = String(
                    document.body?.innerText || ''
                );
                const match = text.match(
                    /\bPNR(?:\s*(?:Number|No\.?))?\s*[:#-]?\s*([0-9]{10})\b/i
                );
                return match ? match[1] : null;
            });
            if (
                pagePNR &&
                /^\d{10}$/.test(String(pagePNR))
            ) {
                confirmedPagePNR = pagePNR;
                console.log(
                    '[PNR] Confirmation page PNR detected.'
                );
                break;
            }
        }
    } catch (pagePNRError) {
        console.warn(
            '[PNR] Confirmation page read attempt failed:',
            attempt,
            pagePNRError.message
        );
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
}
 // EXTRACT FINAL PNR - ROBUST RESPONSE CHECK
let finalPNR =
    (typeof confirmedPagePNR !== 'undefined')
        ? confirmedPagePNR
        : null;
function findPNRInObject(obj, depth = 0) {
    if (!obj || depth > 12) {
        return null;
    }
    if (typeof obj === 'string') {
        const labeledMatch = obj.match(
            /\bPNR\b[\s"'=:_-]*([0-9]{10})\b/i
        );
        return labeledMatch ? labeledMatch[1] : null;
    }
    if (Array.isArray(obj)) {
        for (const item of obj) {
            const found = findPNRInObject(
                item,
                depth + 1
            );
            if (found) return found;
        }
        return null;
    }
    if (typeof obj === 'object') {
        // First inspect explicitly named PNR fields.
        for (const [key, value] of Object.entries(obj)) {
            if (/pnr/i.test(key)) {
                const match = String(
                    value ?? ''
                ).match(/\b([0-9]{10})\b/);
                if (match) {
                    return match[1];
                }
            }
        }
        // Then inspect nested objects and strings.
        for (const value of Object.values(obj)) {
            const found = findPNRInObject(
                value,
                depth + 1
            );
            if (found) return found;
        }
    }
    return null;
}
try {
    if (
        !finalPNR ||
        !/^\d{10}$/.test(String(finalPNR))
    ) {
        finalPNR = findPNRInObject(
            paymentResult
        );
    }
} catch (pnrError) {
    console.warn(
        '[PNR] Extraction error:',
        pnrError.message
    );
}
if (
    !finalPNR ||
    !/^\d{10}$/.test(String(finalPNR))
) {
    console.error(
        '[PNR] PNR not found in confirmation/payment data.'
    );
    this.sendBookingStatus(
        'PNR PENDING',
        'Confirmation received; PNR extraction pending.',
        90
    );
    throw new Error(
        'Valid PNR abhi confirmation/payment response mein nahi mila.'
    );
}
finalPNR = String(finalPNR);
console.log(
    '[PNR] Valid PNR extracted:',
    finalPNR
);
// FINAL PNR + SUCCESS STATUS
this.sendBookingStatus(
    'FINAL PNR ...... ' + finalPNR,
    'FINAL PNR',
    95
);
this.sendBookingStatus(
    'Booking sucessful by BOSS...',
    'BOOKING SUCCESS',
    100
);
console.log(
    '[BOOKING] Booking successfully confirmed. PNR:',
    finalPNR
);
return {
    success: true,
    supported: true,
    pnr: String(finalPNR),
    data: stepResult,
    payment: paymentResult
};
} catch (error) {
    console.error(
        '[API] Sequence execution failed:',
        error.message
    );
    console.error(
        '[API] ERROR STACK:',
        error.stack
    );
    this.sendProgress(
    'BOOKING ERROR',
    'Booking confirmation/PNR nahi mila.',
    20
);
    throw error;
}
    }
}
module.exports = APIEngine;
