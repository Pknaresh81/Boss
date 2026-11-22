// Safe diagnostics update: HTTP classification, JWT expiry inspection, browser health and /nget/error detection.
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

        console.log(
    '[PRE-LOGIN AVL] Response Body:',
    result?.body?.slice(0, 1500)
);

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
async typeHumanLike(page, selector, text, {
    minDelay = 75,
    maxDelay = 195,
    pauseChance = 0.12,
    pauseMin = 220,
    pauseMax = 450
} = {}) {
    const elementHandle = await page.$(selector);
    if (!elementHandle) {
        throw new Error(`Element not found for selector: ${selector}`);
    }

    await elementHandle.click();
    await elementHandle.focus();

    // Existing value clean aur reliable tareeke se clear karein
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');

    // macOS / fallback clear check
    await page.evaluate((sel) => {
        const input = document.querySelector(sel);
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value'
        )?.set;
        if (setter) {
            setter.call(input, '');
        } else {
            input.value = '';
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, selector);

    const str = String(text || '');
    for (let i = 0; i < str.length; i++) {
        const char = str[i];
        const keyDelay = Math.floor(
            Math.random() * (maxDelay - minDelay + 1) + minDelay
        );

        await page.keyboard.type(char, { delay: keyDelay });

        // Kabhi-kabhi thoda sa natural sochne/typing pause
        if (i < str.length - 1 && Math.random() < pauseChance) {
            const extraPause = Math.floor(
                Math.random() * (pauseMax - pauseMin + 1) + pauseMin
            );
            await new Promise((resolve) => setTimeout(resolve, extraPause));
        }
    }

    await page.evaluate((sel) => {
        const input = document.querySelector(sel);
        if (input) {
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }, selector);
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
    if (this.__bossPopupMonitorCleanup) {
        this.__bossPopupMonitorCleanup();
    }
    const monitorPage = this.page;
    const monitorIsWEB4 = isFirefoxWEB4;
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
                detectAndClosePopups();
                const observer = new MutationObserver(() => {
                    detectAndClosePopups();
                });
                observer.observe(document.documentElement, {
                    childList: true,
                    subtree: true,
                    attributes: true
                });
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
    const scanAllFrames = async () => {
        if (monitorPage.isClosed()) return;
        const frames = monitorPage.frames();
        for (const frame of frames) {
            await installPopupWatcherInFrame(frame);
        }
    };
    const handleFrameChange = (frame) => {
        installPopupWatcherInFrame(frame);
    };
    monitorPage.on('frameattached', handleFrameChange);
    monitorPage.on('framenavigated', handleFrameChange);
    await scanAllFrames();
    const popupMonitorTimer = setInterval(() => {
        scanAllFrames();
    }, 1000);
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
        const loginForm = Array.from(
            document.querySelectorAll(
                'input[formcontrolname="userid"], input[formcontrolname="password"]'
            )
        ).some(visible);
        if (loginForm) return false;
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

    if (!isFirefoxWEB4) {
        await new Promise(resolve =>
            setTimeout(resolve, 500)
        );
    }

    // STEP 1 - WAIT FOR LOGIN BUTTON
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
            const loginButtonHandle = await this.page.waitForFunction(
                (isWeb4) => {
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

    const usernameSelector = 'input[formcontrolname="userid"]';
    const passwordSelector = 'input[formcontrolname="password"]';

    // USERNAME - LETTER BY LETTER HUMAN-LIKE TYPING
    await this.page.waitForSelector(usernameSelector, {
        visible: true,
        timeout: 15000
    });
    const usernameInput = await this.page.$(usernameSelector);
    if (!usernameInput) {
        throw new Error(
            `[${this.browserType}] Username field nahi mila.`
        );
    }

    const cleanUsername = String(username || '').trim();
    await this.typeHumanLike(this.page, usernameSelector, cleanUsername, {
        minDelay: 80,
        maxDelay: 190,
        pauseChance: 0.12,
        pauseMin: 200,
        pauseMax: 420
    });

    await this.delay(450);
    console.log(`[AUTO LOGIN ${this.browserType}] Username filled letter-by-letter.`);

    // PASSWORD - LETTER BY LETTER HUMAN-LIKE TYPING
    await this.page.waitForSelector(passwordSelector, {
        visible: true,
        timeout: 15000
    });
    const passwordInput = await this.page.$(passwordSelector);
    if (!passwordInput) {
        throw new Error(
            `[${this.browserType}] Password field nahi mila.`
        );
    }

    const rawPassword = String(password || '');
    await this.typeHumanLike(this.page, passwordSelector, rawPassword, {
        minDelay: 85,
        maxDelay: 210,
        pauseChance: 0.14,
        pauseMin: 240,
        pauseMax: 480
    });

    await this.delay(550);
    console.log(`[AUTO LOGIN ${this.browserType}] Password filled letter-by-letter.`);

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
    isCaptchaError(errorData) {
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
    // COMMON HEADERS
   async getHeaders() {
    return {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        'Client-Device-Id': 'WEB',
        'X-Requested-With': 'XMLHttpRequest'
    };
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
  
    // Sabhi browsers ke liye slow IRCTC navigation timeout
if (typeof this.page.setDefaultNavigationTimeout === 'function') {
    this.page.setDefaultNavigationTimeout(120000);
    console.log(`[AUTO LOGIN ${this.browserType}] Navigation timeout set to 120 seconds.`);
}
const headers = await this.getHeaders();
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
                    const res = await fetch("https://www.irctc.co.in/eticketing/protected/mapps1/masterpsgnlistenquiry", {
                        method: "GET",
                        headers: {
                            "Accept": "application/json, text/plain, */*",
                            "Client-Device-Id": "WEB",
                            "Greq": String(Date.now()),                    
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
        trainClass: String(
            bookingData.trainClass ||
            bookingData.classType ||
            bookingData.class ||
            'SL'
        ).trim().toUpperCase(),
        quota: String(
            bookingData.quota || ''
        ).trim().toUpperCase(),
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
        ).trim().toUpperCase(),
        confirmedOnly: Boolean(
            bookingData.confirmedOnly ??
            bookingData.bookOnlyIfCnf ??
            false
        )
    });
    console.log('[CLASS PAYLOAD] Sending class:', JSON.parse(rawPayload).trainClass);
    console.log('[QUOTA PAYLOAD] Sending quota:', JSON.parse(rawPayload).quota);
    console.log('[PAYMENT PAYLOAD] Sending payment:', JSON.parse(rawPayload).payment);
    const base64Payload = Buffer.from(rawPayload).toString('base64');

    const browserSideAutomationTask = async function(base64Data) {
        var payload = JSON.parse(atob(base64Data));
        var diagnosticLogs = [];

        function getWEB4ToastError() {
            var toastDetails = Array.from(document.querySelectorAll('.ui-toast-detail'));
            for (var i = 0; i < toastDetails.length; i++) {
                var message = (
                    toastDetails[i].innerText ||
                    toastDetails[i].textContent ||
                    ''
                ).replace(/\s+/g, ' ').trim();
                if (/high load|unable to process(?: the)? request|please retry/i.test(message)) {
                    return message;
                }
            }
            return '';
        }

        async function liveProgress(step, message, percentage) {
            diagnosticLogs.push('[LIVE PROGRESS] ' + step + ': ' + message);
            console.log('[LIVE PROGRESS DEBUG] Sending:', step, message, percentage);
            try {
                if (typeof window.__bossSendProgress !== 'function') {
                    console.warn('[LIVE PROGRESS] Bridge unavailable: window.__bossSendProgress is not a function');
                    diagnosticLogs.push('[LIVE PROGRESS] Bridge unavailable.');
                    return false;
                }
                await window.__bossSendProgress(step, message, percentage);
                console.log('[LIVE PROGRESS DEBUG] Bridge call completed:', step, message, percentage);
                return true;
            } catch (progressError) {
                console.error('[LIVE PROGRESS] Bridge error:', progressError);
                diagnosticLogs.push(
                    '[LIVE PROGRESS] Bridge error: ' +
                    (progressError && progressError.message ? progressError.message : String(progressError))
                );
                return false;
            }
        }

        try {
            var currentUrl = window.location.href;
            diagnosticLogs.push("Current Browser URL: " + currentUrl);

            if (
                String(payload.browserType || '').toUpperCase() === 'WEB4' &&
                window.location.hostname !== 'www.irctc.co.in'
            ) {
                diagnosticLogs.push(
                    '[WEB4 GUARD] External payment page detected. Train-search redirect skipped: ' + window.location.href
                );
                return {
                    success: true,
                    paymentPageDetected: true,
                    message: 'WEB4 payment page detected. Continuing QR verification.',
                    logs: diagnosticLogs
                };
            }

            var isFirefoxWEB4Stations = String(payload.browserType || '').toUpperCase() === 'WEB4';
            var trainSearchUrl = isFirefoxWEB4Stations
                ? 'https://www.irctc.co.in/eticket/train-search'
                : 'https://www.irctc.co.in/nget/train-search';

            if (window.location.hostname !== 'www.irctc.co.in') {
                diagnosticLogs.push("Navigating to IRCTC train search page: " + trainSearchUrl);
                window.location.href = trainSearchUrl;
                await new Promise(function(r) { setTimeout(r, 2000); });
            } else {
                await new Promise(function(r) { setTimeout(r, 500); });
            }

            await liveProgress('TRAIN SEARCH', 'Journey details bhar rahe hain...', 22);

            // 1. Fill Stations
            diagnosticLogs.push("Filling From/To station details...");
            if (isFirefoxWEB4Stations) {
                async function selectFirefoxWEB4Station(label, stationCode) {
                    var combo = document.querySelector(
                        'app-jp-input [role="combobox"][aria-label="' + label + '"]'
                    );
                    if (!combo) throw new Error('Firefox  ' + label + ' field nahi mila.');
                    combo.click();
                    await new Promise(function(r) { setTimeout(r, 250); });
                    var searchInput = Array.from(
                        document.querySelectorAll('input[placeholder="Type to search..."]')
                    ).find(function(input) { return input.getClientRects().length > 0; });
                    if (!searchInput) throw new Error('Firefox  ' + label + ' search input nahi mila.');
                    searchInput.focus();

                    var firefoxSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
                    var firefoxText = String(stationCode).trim();
                    firefoxSetter.call(searchInput, firefoxText);
                    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                    searchInput.dispatchEvent(new Event('change', { bubbles: true }));
                    await new Promise(function(r) { setTimeout(r, 500); });

                    var options = Array.from(document.querySelectorAll('[role="option"]')).filter(function(el) {
                        return el.getClientRects().length > 0;
                    });
                    var wantedCode = stationCode.trim().toUpperCase();
                    var match = options.find(function(el) {
                        var text = (el.innerText || el.textContent || '').trim().toUpperCase();
                        return text === wantedCode || new RegExp('(^|[^A-Z])' + wantedCode + '([^A-Z]|$)').test(text);
                    });
                    if (!match) {
                        diagnosticLogs.push(
                            'Firefox  ' + label + ' options: ' +
                            options.map(function(el) { return (el.innerText || el.textContent || '').trim(); }).join(' | ')
                        );
                        throw new Error(label + ' station code option nahi mila: ' + stationCode);
                    }
                    diagnosticLogs.push(label + ' option selecting: ' + (match.innerText || match.textContent || '').trim());
                    match.click();
                    await new Promise(function(r) { setTimeout(r, 400); });
                }

                try {
                    if (payload.fromStation) await selectFirefoxWEB4Station('From station', payload.fromStation);
                    if (payload.toStation) await selectFirefoxWEB4Station('To station', payload.toStation);
                    diagnosticLogs.push('Firefox  From/To stations selected.');
                } catch (e) {
                    diagnosticLogs.push('Firefox  station selection FAILED: ' + e.message);
                    return { success: false, error: e.message, logs: diagnosticLogs };
                }
            } else {
                function getStationInputs() {
                    var inputs = Array.from(document.querySelectorAll('p-autocomplete input'));
                    if (inputs.length < 2) {
                        inputs = Array.from(document.querySelectorAll('input')).filter(function(input) {
                            var ph = (input.getAttribute('placeholder') || '').toUpperCase();
                            var ar = (input.getAttribute('aria-label') || '').toUpperCase();
                            return ph.includes('FROM') || ph.includes('TO') || ar.includes('FROM') || ar.includes('TO');
                        });
                    }
                    return inputs;
                }
                async function setStationValue(input, value) {
                    if (!input) throw new Error('Station input nahi mila.');
                    input.click();
                    input.focus();
                    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    setter.call(input, '');
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    var text = String(value || '').trim();
                    setter.call(input, text);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
                async function selectFirstStationSuggestion() {
                    await new Promise(function(resolve) { setTimeout(resolve, 600); });
                    var panel = document.querySelector(
                        'ul.ui-autocomplete-items, ul.p-autocomplete-items, .ui-autocomplete-panel, .p-autocomplete-panel'
                    );
                    if (!panel) throw new Error('Station suggestions panel nahi mila.');
                    var firstItem = panel.querySelector('li');
                    if (!firstItem) throw new Error('Station suggestion nahi mili.');
                    firstItem.click();
                    await new Promise(function(resolve) { setTimeout(resolve, 300); });
                }

                if (payload.fromStation) {
                    var fromInput = getStationInputs()[0];
                    await setStationValue(fromInput, payload.fromStation);
                    await selectFirstStationSuggestion();
                }
                if (payload.toStation) {
                    var refreshedInputs = getStationInputs();
                    var toInput = refreshedInputs[1];
                    if (!toInput) throw new Error('To station input nahi mila.');
                    await setStationValue(toInput, payload.toStation);
                    await selectFirstStationSuggestion();
                }
            }

            await liveProgress('JOURNEY DATE', 'Journey details bhar rahe hain...', 24);

            // 2. Journey Date
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
                    var isFirefoxWEB4 = String(payload.browserType || '').trim().toUpperCase() === 'WEB4';
                    var calendarTrigger;
                    if (isFirefoxWEB4) {
                        calendarTrigger = Array.from(document.querySelectorAll('.field-inner')).find(function(field) {
                            var label = field.querySelector('.field-label');
                            return label && (label.innerText || label.textContent || '').trim().toLowerCase() === 'date';
                        });
                    } else {
                        calendarTrigger =
                            document.querySelector('p-calendar button') ||
                            document.querySelector('p-calendar input') ||
                            document.querySelector('.ui-calendar button');
                    }
                    diagnosticLogs.push('Journey Date: calendar trigger found = ' + !!calendarTrigger);
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
                                if (currentMonthText.indexOf(targetMonthName) !== -1 && currentYearText == targetYear) break;
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
                        var dayCells = Array.from(
                            document.querySelectorAll('.ui-datepicker-calendar td a, .p-datepicker-calendar td span, .p-datepicker-calendar td a, td.ng-star-inserted a, .ui-state-default')
                        );
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
            if (wanted === "PT") wanted = "PREMIUM TATKAL";
            else if (wanted === "TQ") wanted = "TATKAL";
            else if (wanted === "GN") wanted = "GENERAL";
            diagnosticLogs.push("Selecting Quota: " + wanted);

            try {
                var quotaDropdown = null;
                var isFirefoxWEB4 = String(payload.browserType || '').toUpperCase() === 'WEB4';
                if (isFirefoxWEB4) {
                    quotaDropdown = document.querySelector('app-jp-input [role="combobox"][aria-label="Quota"]');
                    if (!quotaDropdown) throw new Error('Firefox  ka Quota field nahi mila.');
                    quotaDropdown.click();
                    await new Promise(function(resolve) { setTimeout(resolve, 300); });
                    var target = Array.from(document.querySelectorAll('[role="option"]')).find(function(el) {
                        return (el.innerText || el.textContent || '').trim().toUpperCase() === wanted;
                    });
                    if (!target) throw new Error('Quota option nahi mila: ' + wanted);
                    target.click();
                    await new Promise(function(resolve) { setTimeout(resolve, 400); });
                    var selected = (quotaDropdown.innerText || quotaDropdown.textContent || '').toUpperCase();
                    diagnosticLogs.push('Firefox  quota selected value: ' + selected.trim());
                    if (!selected.includes(wanted)) throw new Error('Quota select verify nahi hua.');
                } else {
                    quotaDropdown =
                        document.querySelector('p-dropdown[formcontrolname="journeyQuota"]') ||
                        document.querySelector('p-dropdown[formcontrolname="quota"]') ||
                        document.querySelector('#journeyQuota');
                    if (!quotaDropdown) throw new Error('Quota dropdown nahi mila.');
                    (quotaDropdown.querySelector('.p-dropdown, .ui-dropdown') || quotaDropdown).click();
                    await new Promise(function(resolve) { setTimeout(resolve, 300); });
                    var items = Array.from(
                        document.querySelectorAll('.p-dropdown-panel li, .ui-dropdown-panel li, .p-dropdown-item, .ui-dropdown-item')
                    );
                    var oldTarget = items.find(function(el) {
                        return (el.innerText || el.textContent || '').trim().toUpperCase() === wanted;
                    });
                    if (!oldTarget) throw new Error('Option nahi mila: ' + wanted);
                    oldTarget.click();
                    await new Promise(function(resolve) { setTimeout(resolve, 300); });
                    var oldSelected = (quotaDropdown.querySelector('.p-dropdown-label, .ui-dropdown-label')?.innerText || '').trim().toUpperCase();
                    if (!oldSelected.includes(wanted)) throw new Error('Quota select verify nahi hua.');
                }
                diagnosticLogs.push('Quota successfully selected: ' + wanted);
            } catch (e) {
                diagnosticLogs.push('Quota selection FAILED: ' + e.message);
                return { success: false, error: 'Quota select nahi hua: ' + e.message, logs: diagnosticLogs };
            }

            await liveProgress('SEARCH BUTTON', 'Search Train...', 26);

            // 3. Click Search Trains
            diagnosticLogs.push("Clicking 'Search Trains' button...");
            var searchBtn = null;
            var attempts = 0;
            while (attempts < 15) {
                searchBtn = Array.from(document.querySelectorAll('button')).find(function(b) {
                    var t = (b.innerText || b.textContent || '').trim();
                    return t === 'Search Trains' || t.indexOf('Search') !== -1;
                });
                if (searchBtn && !searchBtn.disabled) break;
                await new Promise(function(r) { setTimeout(r, 300); });
                attempts++;
            }
            if (searchBtn && !searchBtn.disabled) {
                try { searchBtn.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
                await new Promise(function(r) { setTimeout(r, 200); });
                searchBtn.click();
                await liveProgress('SEARCH STARTED', 'Search Train...', 40);
                diagnosticLogs.push("Search Trains clicked successfully.");
            } else {
                return { success: false, error: 'Search Trains button nahi mila ya disabled hai.', logs: diagnosticLogs };
            }

            await liveProgress('SEARCH RESULTS', 'Train search sucessefully...', 28);

            // 4. WAIT FOR TRAIN LIST + EXACT TRAIN
            diagnosticLogs.push("Waiting for train list and searching for exact train number: " + payload.targetTrainNo);
            await liveProgress('TRAIN SEARCH', 'Target train search ki ja rahi hain...', 42);

            var bookNowClicked = false;
            var targetCard = null;
            var classSelectionCompleted = false;
            attempts = 0;
            var journeyDateMissingRetries = 0;

            var irctcErrorPattern = /high load|unable to process(?: the)? request|please retry|please try again|something went wrong|error occurred|service unavailable|too many requests/i;

            function detectAndCloseIRCTCError() {
                var toastEls = Array.from(
                    document.querySelectorAll('.ui-toast, .ui-toast-detail, .toast-message, [role="alert"]')
                );
                var foundToastMsg = '';
                for (var ti = 0; ti < toastEls.length; ti++) {
                    var tTxt = (toastEls[ti].innerText || toastEls[ti].textContent || '').replace(/\s+/g, ' ').trim();
                    if (irctcErrorPattern.test(tTxt)) {
                        foundToastMsg = tTxt;
                        var closeIcon =
                            toastEls[ti].querySelector('a.ui-toast-close-icon, button') ||
                            (toastEls[ti].closest('.ui-toast') && toastEls[ti].closest('.ui-toast').querySelector('a.ui-toast-close-icon, button'));
                        if (closeIcon) {
                            try { closeIcon.click(); } catch (e) {}
                        }
                    }
                }
                if (foundToastMsg) return foundToastMsg;

                var bodyTxt = (document.body.innerText || document.body.textContent || '');
                var bodyMatch = bodyTxt.match(irctcErrorPattern);
                return bodyMatch ? bodyMatch[0] : '';
            }

            function findFreshTrainCard() {
                var possibleCards = Array.from(
                    document.querySelectorAll('p-accordionTab, div.train-avl-col, div.form-group')
                );
                for (var pc = 0; pc < possibleCards.length; pc++) {
                    var card = possibleCards[pc];
                    var possibleText = (card.innerText || card.textContent || '');
                    if (possibleText.indexOf(String(payload.targetTrainNo)) !== -1) {
                        var subCards = card.querySelectorAll('p-accordionTab, div.train-avl-col');
                        if (subCards.length === 0) return card;
                    }
                }
                return null;
            }

            var classErrorRetryCount = 0;
            var classErrorRetryLimit = 20;

            while (classErrorRetryCount < classErrorRetryLimit && journeyDateMissingRetries < 20 && !bookNowClicked) {
                var trainCards = Array.from(
                    document.querySelectorAll('div.train-heading, div.train-avl-col, .form-group, p-accordionTab')
                );
                targetCard = null;
                for (var c = 0; c < trainCards.length; c++) {
                    var cardText = trainCards[c].innerText || trainCards[c].textContent || '';
                    if (cardText.indexOf(String(payload.targetTrainNo)) !== -1) {
                        targetCard = trainCards[c];
                        break;
                    }
                }

                if (!targetCard) {
                    var allElements = Array.from(document.querySelectorAll('span, div, b, strong'));
                    var matchedEl = allElements.find(function(el) {
                        var text = (el.innerText || el.textContent || '').trim();
                        return text === String(payload.targetTrainNo) || text.indexOf('(' + String(payload.targetTrainNo) + ')') !== -1;
                    });
                    if (matchedEl) {
                        targetCard =
                            matchedEl.closest('div.train-avl-col') ||
                            matchedEl.closest('.ng-star-inserted') ||
                            (matchedEl.parentElement && matchedEl.parentElement.parentElement);
                    }
                }

                if (targetCard) {
                    if (classErrorRetryCount === 0) {
                        await liveProgress('TRAIN FOUND', 'Target train mil gayi hain...', 30);
                        diagnosticLogs.push("Exact target train card found for number: " + payload.targetTrainNo);
                        diagnosticLogs.push("FIND TRAIN: Exact target train found.");
                    }

                    var quotaForTiming = String(payload.quota || '').trim().toUpperCase();
                    var classForTiming = String(payload.trainClass || 'SL').trim().toUpperCase();
                    var isTatkalQuota =
                        quotaForTiming === 'TQ' ||
                        quotaForTiming === 'PT' ||
                        quotaForTiming === 'TATKAL' ||
                        quotaForTiming === 'PREMIUM TATKAL';
                    var isWEB4Beta = String(payload.browserType || '').trim().toUpperCase() === 'WEB4';

                    if (classErrorRetryCount === 0) {
                        if (!isWEB4Beta || isTatkalQuota) {
                            await liveProgress('TATKAL WAIT', 'Tatkal opening time check ho raha hain...', 32);
                        } else {
                            await liveProgress('TRAIN FOUND', 'General quota: train select kar rahe hain...', 32);
                        }
                    }

                    if (isTatkalQuota && classErrorRetryCount === 0) {
                        var acClasses = ['1A', '2A', '3A', '3E', 'CC', 'EC', 'EA'];
                        var isACClass = acClasses.indexOf(classForTiming) !== -1;
                        var tatkalHour = isACClass ? 10 : 11;
                        var tatkalMinute = 0;
                        var tatkalSecond = 2;
                        diagnosticLogs.push("Tatkal timing detected.");
                        diagnosticLogs.push("Selected class: " + classForTiming);
                        diagnosticLogs.push("Tatkal opening time: " + (tatkalHour === 10 ? "10:00:02 AM" : "11:00:02 AM"));

                        while (true) {
                            var now = new Date();
                            var currentSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
                            var openingSeconds = tatkalHour * 3600 + tatkalMinute * 60 + tatkalSecond;
                            var remaining = openingSeconds - currentSeconds;
                            if (remaining <= 0) break;

                            var mins = Math.floor(remaining / 60);
                            var secs = remaining % 60;
                            var timerText =
                                'waiting for tatkal window opening.... ' +
                                String(mins).padStart(2, '0') + 'm ' +
                                String(secs).padStart(2, '0') + 's';

                            if (typeof window.__bossTatkalLastSecond === 'undefined') {
                                window.__bossTatkalLastSecond = -1;
                            }
                            if (secs !== window.__bossTatkalLastSecond) {
                                window.__bossTatkalLastSecond = secs;
                                try {
                                    if (typeof window.__bossSendProgress === 'function') {
                                        window.__bossSendProgress('TATKAL WAIT', timerText, 35).catch(function() {});
                                    }
                                } catch (e) {}
                            }
                            await new Promise(function(r) { setTimeout(r, remaining <= 5 ? 250 : 500); });
                        }
                        await liveProgress('TATKAL OPEN', 'Train select kar rahe hain...', 40);
                    }

                    var dateBoxes = Array.from(
                        targetCard.querySelectorAll('div.avl-date, div.pre-avl, div.box-avl, td, div.ng-star-inserted')
                    );
                    var targetDateBox = dateBoxes.find(function(box) {
                        var bText = (box.innerText || box.textContent || '').toUpperCase();
                        return (
                            bText.indexOf('AVAILABLE') !== -1 ||
                            bText.indexOf('WL') !== -1 ||
                            bText.indexOf('RAC') !== -1 ||
                            bText.indexOf('AVL') !== -1
                        ) && bText.length < 40 && box.querySelectorAll('div.avl-date, div.pre-avl').length === 0;
                    });
                    if (targetDateBox) {
                        try { targetDateBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
                        await new Promise(function(r) { setTimeout(r, 200); });
                        targetDateBox.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                        diagnosticLogs.push("Journey date / availability box selected successfully for target train.");
                        await new Promise(function(r) { setTimeout(r, 500); });
                    }

                    var isFirefoxWEB4 = String(payload.browserType || '').trim().toUpperCase() === 'WEB4';
                    if (isFirefoxWEB4) {
                        // Existing WEB4 block remains unchanged
                    } else {
                        var targetClass = String(payload.trainClass || '').trim().toUpperCase();
                        if (!targetClass) {
                            return { success: false, error: 'trainClass missing from payload', logs: diagnosticLogs };
                        }
                        var classNames = {
                            'SL': 'SLEEPER',
                            '3E': 'AC 3 ECONOMY',
                            '3A': 'AC 3 TIER',
                            '2A': 'AC 2 TIER',
                            '1A': 'AC FIRST CLASS'
                        };
                        var wantedClassName = classNames[targetClass] || targetClass;
                        var matchedClassBox = null;

                        var classCandidates = Array.from(targetCard.querySelectorAll('button, a, label, span, div'));
                        for (var ci = 0; ci < classCandidates.length; ci++) {
                            var el = classCandidates[ci];
                            var text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
                            var exactClassText = text.indexOf(wantedClassName) !== -1 && text.indexOf('(' + targetClass + ')') !== -1;
                            if (!exactClassText) continue;

                            var smallerChildren = Array.from(el.querySelectorAll('button, a, label, span, div')).filter(function(child) {
                                var childText = (child.innerText || child.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
                                return childText.indexOf(wantedClassName) !== -1 && childText.indexOf('(' + targetClass + ')') !== -1;
                            });
                            if (smallerChildren.length > 0) continue;

                            matchedClassBox = el.closest('button, a, label, [role="button"], [role="radio"]') || el;
                            break;
                        }

                        if (!matchedClassBox) {
                            diagnosticLogs.push('Class not found yet. Retrying train card...');
                            await new Promise(function(r) { setTimeout(r, 700); });
                            attempts++;
                            continue;
                        }

                        function hasVisibleJourneyDateBoxes(card) {
                            if (!card || !card.isConnected) return false;
                            var boxes = Array.from(
                                card.querySelectorAll('div.avl-date, div.pre-avl, div.box-avl, td, div.ng-star-inserted')
                            );
                            return boxes.some(function(box) {
                                if (!box || !box.isConnected || box.offsetParent === null) return false;
                                var t = (box.innerText || box.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
                                return (
                                    (t.indexOf('AVL') !== -1 || t.indexOf('WL') !== -1 || t.indexOf('AVAILABLE') !== -1 || t.indexOf('RAC') !== -1) &&
                                    t.length < 80 &&
                                    box.querySelectorAll('div.avl-date, div.pre-avl').length === 0
                                );
                            });
                        }

                        try { matchedClassBox.scrollIntoView({ behavior: 'auto', block: 'center' }); } catch (e) {}
                        await new Promise(function(r) { setTimeout(r, 150); });
                        diagnosticLogs.push('CLICKING / EXPANDING REQUESTED CLASS: ' + targetClass);

                        try {
                            matchedClassBox.click();
                            diagnosticLogs.push('CLASS CLICK SENT: ' + targetClass);
                        } catch (classClickError) {
                            diagnosticLogs.push('CLASS CLICK FAILED: ' + (classClickError.message || classClickError));
                            classSelectionCompleted = false;
                            attempts++;
                            continue;
                        }

                        var selected = false;
                        var parentSelected = false;
                        var dateBoxesVisible = false;
                        var classClickErrorMsg = '';

                        for (var clsPoll = 0; clsPoll < 12; clsPoll++) {
                            await new Promise(function(r) { setTimeout(r, 250); });

                            classClickErrorMsg = detectAndCloseIRCTCError();
                            if (classClickErrorMsg) break;

                            var freshCardCheck = findFreshTrainCard() || targetCard;
                            dateBoxesVisible = hasVisibleJourneyDateBoxes(freshCardCheck);

                            var checkNode = matchedClassBox;
                            for (var level = 0; level < 5 && checkNode; level++) {
                                var nodeClass = String(checkNode.className || '').toLowerCase();
                                var ariaSelected = checkNode.getAttribute && checkNode.getAttribute('aria-selected') === 'true';
                                var ariaChecked = checkNode.getAttribute && checkNode.getAttribute('aria-checked') === 'true';
                                if (
                                    nodeClass.indexOf('active') !== -1 ||
                                    nodeClass.indexOf('selected') !== -1 ||
                                    ariaSelected ||
                                    ariaChecked
                                ) {
                                    if (level === 0) selected = true;
                                    else parentSelected = true;
                                    break;
                                }
                                checkNode = checkNode.parentElement;
                            }

                            if (!selected && !parentSelected && freshCardCheck && freshCardCheck.isConnected) {
                                var selectedElements = Array.from(
                                    freshCardCheck.querySelectorAll('.active, .selected, [aria-selected="true"], [aria-checked="true"]')
                                );
                                for (var si = 0; si < selectedElements.length; si++) {
                                    var selectedText = (selectedElements[si].innerText || selectedElements[si].textContent || '')
                                        .replace(/\s+/g, ' ').trim().toUpperCase();
                                    if (selectedText.indexOf('(' + targetClass + ')') !== -1) {
                                        parentSelected = true;
                                        break;
                                    }
                                }
                            }

                            if ((selected || parentSelected) && dateBoxesVisible) break;
                        }

                        // Agar class active/selected dikh rahi hai lekin date/availability boxes hide hain, to ek baar aur click karke expand karein
                        if (!classClickErrorMsg && !dateBoxesVisible) {
                            diagnosticLogs.push('Journey date card hidden after class click. Re-clicking class to expand date boxes...');
                            try {
                                matchedClassBox.click();
                                for (var expWait = 0; expWait < 10; expWait++) {
                                    await new Promise(function(r) { setTimeout(r, 250); });
                                    classClickErrorMsg = detectAndCloseIRCTCError();
                                    if (classClickErrorMsg) break;
                                    var expandedCard = findFreshTrainCard() || targetCard;
                                    if (hasVisibleJourneyDateBoxes(expandedCard)) {
                                        targetCard = expandedCard;
                                        dateBoxesVisible = true;
                                        diagnosticLogs.push('Journey date card expanded and visible now.');
                                        break;
                                    }
                                }
                            } catch (_) {}
                        }

                        if (classClickErrorMsg) {
                            classErrorRetryCount++;
                            var isHighLoadClassErr = /high load/i.test(classClickErrorMsg);
                            var classErrPrefix = isHighLoadClassErr
                                ? 'HIGHLOAD ERROR'
                                : 'UNABLE TO PROCESS ERROR';
                            var classRetryMsg =
                                classErrPrefix +
                                ': (RETRY ' +
                                classErrorRetryCount +
                                ' / ' +
                                classErrorRetryLimit +
                                ')';

                            diagnosticLogs.push(classRetryMsg);
                            await liveProgress(
                                isHighLoadClassErr ? 'HIGH LOAD' : 'UNABLE TO PROCESS REQUEST',
                                classRetryMsg,
                                31
                            );
                            detectAndCloseIRCTCError();

                            if (classErrorRetryCount >= classErrorRetryLimit) {
                                diagnosticLogs.push('STOP: Class selection error retries reached ' + classErrorRetryLimit + '.');
                                break;
                            }

                            await new Promise(function(r) { setTimeout(r, 1500); });
                            attempts++;
                            classSelectionCompleted = false;
                            targetCard = null;
                            matchedClassBox = null;
                            continue;
                        }

                        if ((!selected && !parentSelected) || !dateBoxesVisible) {
                            classErrorRetryCount++;
                            var missingDateRetryMsg =
                                'DATE CARD RETRY: (RETRY ' +
                                classErrorRetryCount +
                                ' / ' +
                                classErrorRetryLimit +
                                ')';
                            classSelectionCompleted = false;
                            diagnosticLogs.push("WARNING: Class or Journey Date card not visible yet. Retry " + classErrorRetryCount + "/" + classErrorRetryLimit);
                            await liveProgress('JOURNEY DATE RETRY', missingDateRetryMsg, 31);

                            if (classErrorRetryCount >= classErrorRetryLimit) {
                                diagnosticLogs.push('STOP: Journey date/class visibility retries reached ' + classErrorRetryLimit + '.');
                                break;
                            }

                            targetCard = null;
                            matchedClassBox = null;
                            await new Promise(function(r) { setTimeout(r, 1200); });
                            attempts++;
                            continue;
                        }
                    }

                    classSelectionCompleted = true;
                    diagnosticLogs.push("SUCCESS: Exact class " + targetClass + " selected successfully.");
                    diagnosticLogs.push("CLASS GATE PASSED: " + targetClass + " -> Book Now may continue.");
                    await liveProgress('CLASS CONFIRMED', 'Class ' + targetClass + ' successfully select ho gayi hain...', 34);

                    for (var avlWait = 0; avlWait < 20; avlWait++) {
                        var hasAvlLoaded = targetCard && /AVL|WL|RAC|AVAILABLE|NOT AVAILABLE|REGRET/i.test(
                            targetCard.innerText || targetCard.textContent || ''
                        );
                        if (hasAvlLoaded) break;
                        await new Promise(function(r) { setTimeout(r, 250); });
                    }

                    // SAFE JOURNEY DATE CARD SELECTOR
                    var journeyDateSelected = false;
                    var targetDay = '';
                    var targetMonth = '';
                    try {
                        var isFirefoxWEB4DateFlow = String(payload.browserType || '').trim().toUpperCase() === 'WEB4';
                        if (isFirefoxWEB4DateFlow && classSelectionCompleted) {
                            journeyDateSelected = true;
                            diagnosticLogs.push('WEB4: Class BOOK button click ho chuka hai; journey-date card search skip ki ja rahi hai.');
                            await liveProgress('CLASS BOOK CLICKED', 'Selected class ka Book button click ho gaya.', 38);
                        } else {
                            await liveProgress('JOURNEY DATE', 'Journey date select ho rahi hain...', 36);
                            diagnosticLogs.push("Targeting journey date card...");
                            var jd = String(payload.journeyDate || '').trim();
                            var monthList = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

                            if (jd.indexOf('-') !== -1) {
                                var dashParts = jd.split('-');
                                if (dashParts.length === 3) {
                                    if (dashParts[0].length === 4) {
                                        targetDay = String(parseInt(dashParts[2], 10));
                                        targetMonth = monthList[parseInt(dashParts[1], 10) - 1];
                                    } else {
                                        targetDay = String(parseInt(dashParts[0], 10));
                                        targetMonth = monthList[parseInt(dashParts[1], 10) - 1];
                                    }
                                }
                            } else if (jd.indexOf('/') !== -1) {
                                var slashParts = jd.split('/');
                                if (slashParts.length === 3) {
                                    if (slashParts[0].length === 4) {
                                        targetDay = String(parseInt(slashParts[2], 10));
                                        targetMonth = monthList[parseInt(slashParts[1], 10) - 1];
                                    } else {
                                        targetDay = String(parseInt(slashParts[0], 10));
                                        targetMonth = monthList[parseInt(slashParts[1], 10) - 1];
                                    }
                                }
                            } else if (jd.length === 8) {
                                targetDay = String(parseInt(jd.substring(6, 8), 10));
                                targetMonth = monthList[parseInt(jd.substring(4, 6), 10) - 1];
                            }

                            diagnosticLogs.push("Looking for date: " + targetDay + " " + targetMonth);

                            var freshDateCardTrain = null;
                            var dateTrainCards = Array.from(
                                document.querySelectorAll('p-accordionTab, div.train-avl-col, div.form-group')
                            );
                            for (var dtc = 0; dtc < dateTrainCards.length; dtc++) {
                                var trainCandidate = dateTrainCards[dtc];
                                var trainText = (trainCandidate.innerText || trainCandidate.textContent || '');
                                if (trainText.indexOf(String(payload.targetTrainNo)) !== -1) {
                                    var nestedTrainCards = trainCandidate.querySelectorAll('p-accordionTab, div.train-avl-col');
                                    if (nestedTrainCards.length === 0) {
                                        freshDateCardTrain = trainCandidate;
                                        break;
                                    }
                                }
                            }
                            if (freshDateCardTrain) {
                                targetCard = freshDateCardTrain;
                                diagnosticLogs.push("Fresh target train card found after class selection.");
                            } else {
                                targetCard = null;
                                diagnosticLogs.push("Fresh target train card not found after class selection.");
                            }

                            if (targetCard && targetDay && targetMonth) {
                                var wantedDateText = (targetDay + ' ' + targetMonth).toUpperCase();
                                var dateCandidates = Array.from(targetCard.querySelectorAll('div, td, span, button, a'));
                                dateCandidates.sort(function(a, b) {
                                    return a.querySelectorAll('*').length - b.querySelectorAll('*').length;
                                });
                                var exactDateElement = dateCandidates.find(function(el) {
                                    var txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
                                    var hasDate = txt.indexOf(wantedDateText) !== -1;
                                    var hasAvailability =
                                        txt.indexOf('AVL') !== -1 ||
                                        txt.indexOf('WL') !== -1 ||
                                        txt.indexOf('AVAILABLE') !== -1 ||
                                        txt.indexOf('RAC') !== -1;
                                    return hasDate && hasAvailability && txt.length < 100;
                                });

                                if (exactDateElement) {
                                    try { exactDateElement.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
                                    await new Promise(function(r) { setTimeout(r, 100); });
                                    exactDateElement.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                                    journeyDateSelected = true;
                                    await liveProgress('DATE CONFIRMED', 'Journey date successfully select ho gayi hain.', 38);
                                    diagnosticLogs.push("Journey date selected successfully: " + targetDay + " " + targetMonth);

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

                                    await new Promise(function(r) { setTimeout(r, 800); });
                                } else {
                                    diagnosticLogs.push("Journey date NOT found: " + targetDay + " " + targetMonth);
                                }
                            }
                        }
                    } catch (dateError) {
                        journeyDateSelected = false;
                        diagnosticLogs.push("Date selector error: " + (dateError.message || dateError));
                    }

                    if (!journeyDateSelected) {
                        journeyDateMissingRetries++;
                        diagnosticLogs.push('Journey date card visible nahi hua. Fresh train/class retry: ' + journeyDateMissingRetries + '/20');
                        classSelectionCompleted = false;
                        targetCard = null;
                        matchedClassBox = null;
                        attempts++;
                        if (journeyDateMissingRetries >= 20) {
                            diagnosticLogs.push('STOP: Journey date missing hone par 20 retries complete.');
                            break;
                        }
                        await new Promise(function(resolve) { setTimeout(resolve, 1500); });
                        continue;
                    }

                    if (!classSelectionCompleted) {
                        diagnosticLogs.push("SAFETY: Book Now blocked because class selection is not completed.");
                        await new Promise(function(r) { setTimeout(r, 500); });
                        attempts++;
                        continue;
                    }

                    diagnosticLogs.push("Class selection confirmed. Book Now is now allowed.");
                    if (
                        String(payload.browserType || '').trim().toUpperCase() === 'WEB4' &&
                        bookNowClicked
                    ) {
                        diagnosticLogs.push('WEB4: Passenger form ready; skipping old Book Now retry loop.');
                        break;
                    }

                    diagnosticLogs.push("Searching for Book Now button...");
                    var quotaValue = String(payload.quota || '').trim().toUpperCase();
                    var isTatkal =
                        quotaValue === 'TQ' ||
                        quotaValue === 'PT' ||
                        quotaValue === 'TATKAL' ||
                        quotaValue === 'PREMIUM TATKAL';

                    var bookRetryLimit = isTatkal ? 60 : 30;
                    var bookNowErrorRetryCount = 0;
                    var bookNowErrorRetryLimit = 20;

                    var passengerPageReached = false;
                    var passengerPageObserver = null;
                    var checkPassengerPage = function() {
                        if (passengerPageReached) return true;
                        var currentUrl = window.location.href.toLowerCase();
                        var passengerInput = document.querySelector(
                            'input[formcontrolname="passengerName"], input[placeholder*="Full Name"], input[placeholder*="Govt"]'
                        );
                        if (currentUrl.indexOf('psgninput') !== -1 || passengerInput) {
                            passengerPageReached = true;
                            bookNowClicked = true;
                            diagnosticLogs.push("PASSENGER PAGE DETECTED! All Book Now retries stopped.");
                            if (passengerPageObserver) passengerPageObserver.disconnect();
                            return true;
                        }
                        return false;
                    };
                    passengerPageObserver = new MutationObserver(function() { checkPassengerPage(); });
                    passengerPageObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
                    window.addEventListener('popstate', checkPassengerPage);
                    window.addEventListener('hashchange', checkPassengerPage);
                    checkPassengerPage();

                    async function reselectClassAndDateForRetry(card) {
                        if (!card) return false;
                        var retryClass = String(payload.trainClass || '').trim().toUpperCase();
                        var retryClassName = classNames[retryClass] || retryClass;
                        var retryClassEl = Array.from(card.querySelectorAll('button,a,label,span,div')).find(function(el) {
                            var t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
                            return t.indexOf('(' + retryClass + ')') !== -1 && t.indexOf(retryClassName) !== -1;
                        });
                        if (retryClassEl) {
                            retryClassEl.click();
                            await new Promise(function(r) { setTimeout(r, 400); });
                            detectAndCloseIRCTCError();
                        }

                        var refreshedCard = findFreshTrainCard() || card;
                        var retryDateEl = Array.from(refreshedCard.querySelectorAll('div,td,span,button,a'))
                            .sort(function(a, b) { return a.querySelectorAll('*').length - b.querySelectorAll('*').length; })
                            .find(function(el) {
                                var t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
                                return (
                                    t.indexOf((targetDay + ' ' + targetMonth).toUpperCase()) !== -1 &&
                                    (t.indexOf('AVL') !== -1 || t.indexOf('WL') !== -1 || t.indexOf('AVAILABLE') !== -1 || t.indexOf('RAC') !== -1) &&
                                    t.length < 80
                                );
                            });
                        if (retryDateEl) {
                            retryDateEl.click();
                            await new Promise(function(r) { setTimeout(r, 400); });
                            detectAndCloseIRCTCError();
                            return true;
                        }
                        return false;
                    }

                    for (var bTry = 0; bTry < bookRetryLimit && !passengerPageReached; bTry++) {
                        if (checkPassengerPage()) break;
                        detectAndCloseIRCTCError();

                        targetCard = findFreshTrainCard();
                        if (!targetCard) {
                            diagnosticLogs.push("Retry: Target train card DOM mein abhi available nahi hai. Waiting...");
                            await new Promise(function(r) { setTimeout(r, 500); });
                            continue;
                        }

                        if (bTry > 0) {
                            diagnosticLogs.push("Retry attempt #" + (bTry + 1) + ": Re-selecting Class & Date before Book Now...");
                            await reselectClassAndDateForRetry(targetCard);
                            targetCard = findFreshTrainCard() || targetCard;
                        }

                        var bookBtn = Array.from(targetCard.querySelectorAll('button, a')).find(function(b) {
                            var t = (b.innerText || b.textContent || '').trim().toUpperCase();
                            return t.indexOf('BOOK NOW') !== -1;
                        });

                        var btnDisabled = bookBtn && (
                            bookBtn.disabled ||
                            bookBtn.getAttribute('disabled') !== null ||
                            bookBtn.getAttribute('aria-disabled') === 'true' ||
                            bookBtn.classList.contains('disabled')
                        );

                        if (bookBtn && !btnDisabled) {
                            try { bookBtn.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
                            await new Promise(function(r) { setTimeout(r, 150); });
                            if (checkPassengerPage()) break;

                            diagnosticLogs.push("Attempt " + (bTry + 1) + ": Clicking Book Now...");
                            try {
                                bookBtn.click();
                                await liveProgress('BOOK NOW', 'BOOKING START KAR RAHE HAIN...', 45);
                                diagnosticLogs.push("Book Now click sent. Passenger page ya IRCTC response ka wait...");

                                var bookNowErrorFound = false;
                                var detectedBookErrorText = '';

                                for (var bnWait = 0; bnWait < 48 && !passengerPageReached; bnWait++) {
                                    await new Promise(function(r) { setTimeout(r, 250); });
                                    if (checkPassengerPage()) break;

                                    detectedBookErrorText = detectAndCloseIRCTCError();
                                    if (detectedBookErrorText) {
                                        bookNowErrorFound = true;
                                        break;
                                    }
                                }

                                if (passengerPageReached) {
                                    bookNowClicked = true;
                                    await liveProgress('PASSENGER PAGE', 'FILLING PASSENGER DETAILS...', 50);
                                    diagnosticLogs.push("Passenger page reached. Book Now retry stopped.");
                                    break;
                                }

                                if (bookNowErrorFound) {
                                    bookNowErrorRetryCount++;
                                    diagnosticLogs.push(
                                        "IRCTC BOOK error detected (" + detectedBookErrorText + "). Retry " +
                                        bookNowErrorRetryCount + "/" + bookNowErrorRetryLimit
                                    );
                                    await liveProgress('BOOKING RETRY', 'Error aaya, Book Now retry (' + bookNowErrorRetryCount + ')...', 42);

                                    if (bookNowErrorRetryCount >= bookNowErrorRetryLimit) {
                                        diagnosticLogs.push("Maximum confirmed BOOK error retries reached. Stopping safely.");
                                        break;
                                    }

                                    await new Promise(function(r) { setTimeout(r, 1500); });
                                    continue;
                                }

                                var stillOnTrainList = Array.from(document.querySelectorAll('button, a')).some(function(b) {
                                    return (b.innerText || '').trim().toUpperCase().indexOf('BOOK NOW') !== -1;
                                });
                                if (stillOnTrainList && !passengerPageReached) {
                                    diagnosticLogs.push("Book Now click ke baad page aage nahi badha (silent failure). Retrying...");
                                    await new Promise(function(r) { setTimeout(r, 1000); });
                                    continue;
                                }
                            } catch (clickError) {
                                diagnosticLogs.push("Book Now click error: " + (clickError.message || clickError) + " — retrying...");
                            }
                        } else {
                            diagnosticLogs.push("Book Now not ready/disabled. Retry " + (bTry + 1) + "/" + bookRetryLimit);
                        }

                        await new Promise(function(r) { setTimeout(r, 1500); });
                    }

                    if (passengerPageObserver) {
                        try { passengerPageObserver.disconnect(); } catch (e) {}
                    }

                    if (bookNowClicked) {
                        diagnosticLogs.push("Book Now process completed successfully.");
                        break;
                    }
                    diagnosticLogs.push("Book Now retry window finished for current train card.");
                } else {
                    diagnosticLogs.push("Target train not found yet. Waiting for train list...");
                    await new Promise(function(r) { setTimeout(r, 400); });
                }
                attempts++;
                await new Promise(function(r) { setTimeout(r, 500); });
            }

            if (!bookNowClicked) {
                return {
                    success: false,
                    error: 'Target train (' + payload.targetTrainNo + ') ya uska Book Now button retry window mein nahi mila.',
                    logs: diagnosticLogs
                };
            }

            diagnosticLogs.push("Target train booking flow moved forward successfully.");

            // 5. Passenger Page + Form
            diagnosticLogs.push("Waiting for passenger input form to load...");
            var isFirefoxWEB4 = String(payload.browserType || '').toUpperCase() === 'WEB4';
            var navSuccess = false;
            var nameInputs = [];

            if (isFirefoxWEB4) {
                diagnosticLogs.push("WEB4: Waiting for passenger page...");
                for (var w = 0; w < 60; w++) {
                    await new Promise(function(resolve) { setTimeout(resolve, 500); });
                    if (window.location.href.indexOf('psgninput') !== -1) {
                        navSuccess = true;
                        break;
                    }
                }
                if (!navSuccess) {
                    return { success: false, error: 'WEB4: Passenger page nahi mila.', logs: diagnosticLogs };
                }
                diagnosticLogs.push("WEB4: Passenger page opened.");

                var newPassengerBtn = document.querySelector('button.btn.btn-new-passenger');
                if (newPassengerBtn) {
                    newPassengerBtn.click();
                    diagnosticLogs.push("WEB4: New Passenger button clicked.");
                } else {
                    return { success: false, error: 'WEB4: New Passenger button nahi mila.', logs: diagnosticLogs };
                }

                for (var f = 0; f < 40; f++) {
                    await new Promise(function(resolve) { setTimeout(resolve, 250); });
                    nameInputs = Array.from(
                        document.querySelectorAll('input[formcontrolname="passengerName"], input[placeholder*="Full Name"], input[placeholder*="Govt"]')
                    );
                    if (nameInputs.length > 0) break;
                }
                navSuccess = nameInputs.length > 0;
            } else {
                while (true) {
                    await new Promise(function(resolve) { setTimeout(resolve, 500); });
                    var currentUrl = window.location.href;
                    nameInputs = Array.from(
                        document.querySelectorAll('input[formcontrolname="passengerName"], input[placeholder*="Full Name"], input[placeholder*="Govt"]')
                    );
                    if (currentUrl.indexOf('psgninput') !== -1 && nameInputs.length > 0) {
                        navSuccess = true;
                        break;
                    }
                }
            }

            if (!navSuccess || nameInputs.length === 0) {
                return { success: false, error: 'Passenger page/form load nahi hua.', logs: diagnosticLogs };
            }

            diagnosticLogs.push("Passenger page + form ready.");
            await liveProgress('PASSENGER DETAILS', 'FILLING PASSENGER DETAILS....', 60);

            var passengers = payload.passengers || [];
            if (passengers.length === 0) {
                passengers = [{ name: "Passenger 1", age: 30, gender: "M" }];
            }

            for (var i = 0; i < passengers.length; i++) {
                var p = passengers[i];
                if (i > 0) {
                    if (String(payload.browserType || '').trim().toUpperCase() === 'WEB4') {
                        var web4NewPassengerBtn = Array.from(document.querySelectorAll('button, a, span')).find(function(el) {
                            var txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                            return txt === 'new passenger' && el.getClientRects().length > 0;
                        });
                        if (web4NewPassengerBtn) {
                            web4NewPassengerBtn.click();
                            diagnosticLogs.push('WEB4: New Passenger clicked for passenger ' + (i + 1));
                            await new Promise(function(resolve) { setTimeout(resolve, 400); });
                        } else {
                            diagnosticLogs.push('WEB4 ERROR: New Passenger button nahi mila, passenger ' + (i + 1));
                            break;
                        }
                    } else {
                        var addBtn = document.querySelector(
                            'span.add-passenger, a.add-passenger, span.fa-plus-circle, button[label*="Add Passenger"]'
                        );
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
                            await new Promise(function(resolve) { setTimeout(resolve, 600); });
                        } else {
                            diagnosticLogs.push("Warning: 'Add Passenger' button nahi mila.");
                        }
                    }
                }

                var nameInputs = Array.from(
                    document.querySelectorAll('input[formcontrolname="passengerName"], input[placeholder*="Full Name"], input[placeholder*="Govt"]')
                ).filter(function(el) { return el.offsetParent !== null; });

                var ageInputs = Array.from(
                    document.querySelectorAll('input[formcontrolname="passengerAge"], input[placeholder*="Age"]')
                ).filter(function(el) { return el.offsetParent !== null; });

                var passengerIndex = String(payload.browserType || '').trim().toUpperCase() === 'WEB4' ? 0 : i;
                var nameInput = nameInputs[passengerIndex];
                var ageInput = ageInputs[passengerIndex];

                var nameToFill = String(p.name || p.passengerName || 'Test Passenger');
                var ageToFill = String(p.age || p.passengerAge || 30);
                var genderValue = String(p.gender || p.passengerGender || 'M').trim().toUpperCase();

                var wantedGender = 'M';
                if (genderValue === 'F' || genderValue.indexOf('FEMALE') === 0) wantedGender = 'F';
                else if (genderValue === 'T' || genderValue.indexOf('TRANS') === 0) wantedGender = 'T';

                if (nameInput && ageInput) {
                    var inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    nameInput.focus();
                    inputSetter.call(nameInput, nameToFill);
                    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
                    nameInput.dispatchEvent(new Event('change', { bubbles: true }));
                    nameInput.blur();

                    ageInput.focus();
                    inputSetter.call(ageInput, ageToFill);
                    ageInput.dispatchEvent(new Event('input', { bubbles: true }));
                    ageInput.dispatchEvent(new Event('change', { bubbles: true }));
                    ageInput.blur();

                    try {
                        if (String(payload.browserType || '').trim().toUpperCase() === 'WEB4') {
                            var web4GenderDropdown = document.querySelectorAll('p-dropdown[formcontrolname="passengerGender"]')[0];
                            var web4GenderLabel = wantedGender === 'F' ? 'Female' : wantedGender === 'T' ? 'Transgender' : 'Male';
                            if (web4GenderDropdown) {
                                var web4CurrentLabel = web4GenderDropdown.querySelector('.ui-dropdown-label');
                                var web4CurrentText = web4CurrentLabel ? (web4CurrentLabel.innerText || '').trim() : '';
                                if (web4CurrentText.toUpperCase() !== web4GenderLabel.toUpperCase()) {
                                    var triggerEl = web4GenderDropdown.querySelector('.ui-dropdown-trigger') || web4GenderDropdown;
                                    triggerEl.click();
                                    await new Promise(function(r) { setTimeout(r, 150); });
                                    var optEl = Array.from(
                                        document.querySelectorAll('.ui-dropdown-panel li[role="option"], .p-dropdown-panel li[role="option"], li[role="option"]')
                                    ).filter(function(o) { return o.getClientRects().length > 0; }).find(function(o) {
                                        var t = (o.getAttribute('aria-label') || o.innerText || o.textContent || '').trim().toUpperCase();
                                        return t === web4GenderLabel.toUpperCase();
                                    });
                                    if (optEl) {
                                        optEl.click();
                                        await new Promise(function(r) { setTimeout(r, 180); });
                                        var verifyLabel4 = web4GenderDropdown.querySelector('.ui-dropdown-label');
                                        var verifyText4 = verifyLabel4 ? (verifyLabel4.innerText || '').trim() : '';
                                        if (verifyText4.toUpperCase() === web4GenderLabel.toUpperCase()) {
                                            var addBtn4 = Array.from(document.querySelectorAll('button.ap-add-btn')).find(function(b) {
                                                return (b.innerText || b.textContent || '').trim().toUpperCase() === 'ADD' && !b.disabled && b.getClientRects().length > 0;
                                            });
                                            if (addBtn4) addBtn4.click();
                                        }
                                    }
                                }
                            }
                        } else {
                            var gSelect = document.querySelectorAll('select[formcontrolname="passengerGender"]')[i] || null;
                            if (!gSelect) {
                                var allSels = Array.from(document.querySelectorAll('select'));
                                gSelect = allSels.find(function(s) {
                                    var near = ((s.parentElement?.innerText || '') + ' ' + (s.parentElement?.parentElement?.innerText || '')).toUpperCase();
                                    return near.indexOf('GENDER') !== -1;
                                }) || null;
                            }
                            if (gSelect) {
                                var matchOpt = Array.from(gSelect.options || []).find(function(opt) {
                                    var ot = String(opt.text || opt.innerText || '').trim().toUpperCase();
                                    var ov = String(opt.value || '').trim().toUpperCase();
                                    if (wantedGender === 'M') return ot === 'MALE' || ot === 'M' || ov === 'M' || ov === 'MALE';
                                    if (wantedGender === 'F') return ot === 'FEMALE' || ot === 'F' || ov === 'F' || ov === 'FEMALE';
                                    return ot === 'TRANSGENDER' || ot === 'T' || ov === 'T' || ov === 'TRANSGENDER';
                                });
                                if (matchOpt) {
                                    var nativeSelectSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
                                    nativeSelectSetter.call(gSelect, matchOpt.value);
                                    gSelect.dispatchEvent(new Event('input', { bubbles: true }));
                                    gSelect.dispatchEvent(new Event('change', { bubbles: true }));
                                    gSelect.dispatchEvent(new Event('blur', { bubbles: true }));
                                }
                            } else {
                                var primeGenderDropdowns = Array.from(
                                    document.querySelectorAll('p-dropdown[formcontrolname="passengerGender"]')
                                ).filter(function(el) { return el.offsetParent !== null; });
                                var primeGenderDropdown = primeGenderDropdowns[i] || primeGenderDropdowns[primeGenderDropdowns.length - 1];
                                if (primeGenderDropdown) {
                                    var trigger = primeGenderDropdown.querySelector('.ui-dropdown-trigger, .p-dropdown-trigger') || primeGenderDropdown;
                                    trigger.click();
                                    await new Promise(function(r) { setTimeout(r, 150); });
                                    var wantedLabel = wantedGender === 'F' ? 'FEMALE' : wantedGender === 'T' ? 'TRANSGENDER' : 'MALE';
                                    var matchedPrimeOpt = Array.from(
                                        document.querySelectorAll('.ui-dropdown-panel li, .p-dropdown-panel li, li[role="option"]')
                                    ).filter(function(opt) { return opt.getClientRects().length > 0; }).find(function(opt) {
                                        var txt = (opt.innerText || opt.textContent || '').trim().toUpperCase();
                                        return txt === wantedLabel || txt === wantedGender;
                                    });
                                    if (matchedPrimeOpt) {
                                        matchedPrimeOpt.click();
                                        await new Promise(function(r) { setTimeout(r, 120); });
                                    }
                                }
                            }
                        }
                    } catch (gErr) {
                        diagnosticLogs.push('Gender error: ' + (gErr && gErr.message ? gErr.message : String(gErr)));
                    }

                    diagnosticLogs.push('Passenger ' + (i + 1) + ' Name, Age and Gender filled together (' + wantedGender + ').');
                    await new Promise(function(resolve) { setTimeout(resolve, 100); });
                }
            }

            // 4. Mobile Number Entry
            var mobileVal = payload.mobile || '';
            try {
                diagnosticLogs.push("Filling mobile number...");
                var mobileInput =
                    document.querySelector('input[formcontrolname*="mobile" i]') ||
                    document.querySelector('input[id*="mobile" i]') ||
                    document.querySelector('input[name*="mobile" i]') ||
                    document.querySelector('input[placeholder*="mobile" i]') ||
                    document.querySelector('input[type="tel"]');
                if (!mobileInput) throw new Error("Mobile field nahi mila.");
                mobileInput.focus();
                var nativeMobileSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
                nativeMobileSetter.call(mobileInput, "");
                mobileInput.dispatchEvent(new Event("input", { bubbles: true }));
                mobileInput.dispatchEvent(new Event("change", { bubbles: true }));
                await new Promise(function(r) { setTimeout(r, 100); });

                var mobStr = String(mobileVal);
                nativeMobileSetter.call(mobileInput, mobStr);
                mobileInput.dispatchEvent(new Event("input", { bubbles: true }));
                mobileInput.dispatchEvent(new Event("change", { bubbles: true }));
                mobileInput.dispatchEvent(new Event("blur", { bubbles: true }));

                if (mobileInput.value === mobStr && mobStr.length > 0) {
                    diagnosticLogs.push("Mobile number filled successfully.");
                } else {
                    diagnosticLogs.push("Mobile number set nahi hua.");
                }
            } catch (mErr) {
                diagnosticLogs.push("Mobile error: " + mErr.message);
            }

            await new Promise(function(r) { setTimeout(r, 300); });

          // BOOK ONLY IF CONFIRMED BERTH - BOOK TAB CHECKBOX BASED
            try {
                if (!Boolean(payload.confirmedOnly)) {
                    diagnosticLogs.push("Book Only If Confirmed Berth skipped (unchecked in Book tab).");
                } else {
                    var confirmCheckbox = Array.from(document.querySelectorAll('input[type="checkbox"], input[type="radio"]')).find(function(el) {
                        if (!el || !el.isConnected || el.checked) return false;
                        var parentText = el.parentElement ? (el.parentElement.innerText || el.parentElement.textContent || '') : '';
                        return String(parentText).toUpperCase().indexOf('BOOK ONLY IF') !== -1 || String(parentText).toUpperCase().indexOf('CONFIRMED') !== -1;
                    });
                    if (confirmCheckbox) {
                        confirmCheckbox.click();
                        diagnosticLogs.push("Book Only If Confirmed Berth ticked (checked in Book tab).");
                        await new Promise(function(r) { setTimeout(r, 100); });
                    }
                }
            } catch (_) {}

            // 6. UPI Payment Selection
            diagnosticLogs.push("Selecting BHIM/UPI payment option precisely...");
            var upiSelected = false;
            try {
                var paymentLabels = Array.from(document.querySelectorAll('label, span, div.row, p-radiobutton, .p-radiobutton'));
                var targetUpiLabel = paymentLabels.find(function(el) {
                    var text = (el.innerText || el.textContent || '').trim();
                    return (text.includes('Pay through BHIM/UPI') || text === 'BHIM/UPI') && !text.includes('UPI_CC') && !text.includes('Credit & Debit');
                });
                if (targetUpiLabel) {
                    var radioInput = targetUpiLabel.querySelector('input') || targetUpiLabel.closest('p-radiobutton, .p-radiobutton')?.querySelector('input') || targetUpiLabel;
                    if (radioInput) {
                        radioInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        await new Promise(function(r) { setTimeout(r, 100); });
                        ['mousedown', 'mouseup', 'click'].forEach(function(eventType) {
                            radioInput.dispatchEvent(new MouseEvent(eventType, { view: window, bubbles: true, cancelable: true, buttons: 1 }));
                        });
                        radioInput.click();
                        radioInput.dispatchEvent(new Event('change', { bubbles: true }));
                        radioInput.dispatchEvent(new Event('input', { bubbles: true }));
                        upiSelected = true;
                        diagnosticLogs.push("Successfully selected the lower BHIM/UPI payment option.");
                    }
                }
                if (!upiSelected) {
                    var allRadios = Array.from(document.querySelectorAll('input[type="radio"]'));
                    if (allRadios.length > 1) {
                        var upiRadio = allRadios.find(function(r) {
                            var parentText = (r.closest('label, div, p-radiobutton')?.innerText || '').toUpperCase();
                            return parentText.includes('BHIM/UPI') && !parentText.includes('UPI_CC');
                        });
                        if (upiRadio) {
                            upiRadio.click();
                            upiRadio.dispatchEvent(new Event('change', { bubbles: true }));
                            upiSelected = true;
                        }
                    }
                }
            } catch (payErr) {
                diagnosticLogs.push("UPI Selection Error: " + payErr.message);
            }

            await new Promise(function(r) { setTimeout(r, 3500); });

            var loginModalOpen = document.querySelector('input[formcontrolname="userid"]');
            var pageBodyUpper = (document.body.innerText || '').toUpperCase();
            var currentHour = new Date().getHours();
            var tatkalSlot = currentHour === 10 ? '10:00 AM (AC)' : currentHour === 11 ? '11:00 AM (Non-AC)' : 'Tatkal';

            if (loginModalOpen || (pageBodyUpper.includes('LOGIN') && !pageBodyUpper.includes('LOGOUT') && !isFirefoxWEB4)) {
                return {
                    success: false,
                    error: 'IRCTC Session Logged Out at ' + tatkalSlot + ' time!',
                    logs: diagnosticLogs
                };
            }

// FIRST CONTINUE / WEB4 CALCULATE FARE
var isFirefoxWEB4PaymentCalculateFare =
    String(payload.browserType || '').trim().toUpperCase() === 'WEB4';

function closeAnyIRCTCErrors() {
    var closeSelectors = [
        'a.ui-toast-close-icon',
        '.ui-toast-close-icon',
        '.pi-times',
        '.ui-toast button',
        '[aria-label*="close" i]'
    ];
    for (var s = 0; s < closeSelectors.length; s++) {
        var btns = Array.from(document.querySelectorAll(closeSelectors[s]));
        for (var b = 0; b < btns.length; b++) {
            try {
                if (btns[b] && btns[b].isConnected) {
                    btns[b].click();
                }
            } catch (_) {}
        }
    }
}

function isButtonClickable(btn) {
    if (!btn || !btn.isConnected || btn.offsetParent === null) return false;
    if (btn.disabled === true) return false;
    if (String(btn.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return false;
    if (btn.classList && btn.classList.contains('disabled')) return false;
    return true;
}
function findContinueButton(exactWeb4Second) {
 return Array.from(document.querySelectorAll('button')).find(function(b) {
     if (!isButtonClickable(b)) return false;
     var t = (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
     if (exactWeb4Second) {
         return t === 'continue to payment' || t === 'continue';
     }
     return t.indexOf('continue') !== -1;
 }) || null;
}

if (isFirefoxWEB4PaymentCalculateFare) {
 var calculateFareBtn = null;
 var web4FareRetrySuccess = false;
 var fareTry = 0;
 var web4FareRetryLimit = 20;

 while (!web4FareRetrySuccess && fareTry < web4FareRetryLimit) {
     calculateFareBtn = null;
     for (var fareButtonWait = 0; fareButtonWait < 60; fareButtonWait++) {
         calculateFareBtn = Array.from(document.querySelectorAll('button.btn-calc-fare')).find(function(b) {
             var text = (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
             return text.includes('calculate fare') && b.getClientRects().length > 0 && isButtonClickable(b);
         });
         if (calculateFareBtn) break;
         await new Promise(function(resolve) { setTimeout(resolve, 500); });
     }
     if (!calculateFareBtn) {
         return { success: false, error: 'WEB4: Calculate Fare button nahi mila ya enabled nahi hua.', logs: diagnosticLogs };
     }
     calculateFareBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
     await new Promise(function(resolve) { setTimeout(resolve, 500); });
     fareTry++;
     diagnosticLogs.push('WEB4: Calculate Fare actual click attempt ' + fareTry + '/' + web4FareRetryLimit);
     calculateFareBtn.click();

     var fareResponseDetected = false;
     for (var fareWait = 0; fareWait < 120; fareWait++) {
         await new Promise(function(resolve) { setTimeout(resolve, 500); });
         var currentFareButton = Array.from(document.querySelectorAll('button.btn-calc-fare')).find(function(b) {
             return b.getClientRects().length > 0 && isButtonClickable(b);
         });
         var currentFareText = document.body.innerText || '';
         var reviewDetected = /\bbooking\s+review\b/i.test(currentFareText);
         if (reviewDetected && !currentFareButton) {
             web4FareRetrySuccess = true;
             fareResponseDetected = true;
             diagnosticLogs.push('WEB4: Calculate Fare click verified. Review page confirmed.');
             break;
         }
         var fareToastError = getWEB4ToastError();
         if (fareToastError) {
             diagnosticLogs.push('WEB4 Calculate Fare error: ' + fareToastError);
             var fareErrorLabel = /high load/i.test(fareToastError) ? 'HIGHLOAD' : 'UNABLE TO PROCESS';
             await liveProgress(
                 'BOOKING RETRY',
                 fareErrorLabel + ' ERROR: (RETRY ' + fareTry + ' / ' + web4FareRetryLimit + ')',
                 20
             );
             closeAnyIRCTCErrors();
             if (fareTry < web4FareRetryLimit) {
                 await new Promise(function(resolve) { setTimeout(resolve, 4500); });
             }
             fareResponseDetected = true;
             break;
         }
     }
     if (web4FareRetrySuccess) break;
     if (!fareResponseDetected) {
         return { success: false, error: 'WEB4: Calculate Fare click ke baad 60 seconds tak page response nahi mila.', logs: diagnosticLogs };
     }
 }

 if (!web4FareRetrySuccess) {
     return {
         success: false,
         error: 'WEB4: Calculate Fare failed after ' + web4FareRetryLimit + ' retries.',
         logs: diagnosticLogs
     };
 }
} else {
 var anyPaymentChecked = Array.from(document.querySelectorAll('input[type="radio"]')).some(function(r) { return r.checked; });
 if (!anyPaymentChecked) {
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

    var continueBtn1 = findContinueButton(false);
    if (!continueBtn1) {
        return { success: false, error: 'First continue button nahi mila.', logs: diagnosticLogs };
    }
    await new Promise(function(r) { setTimeout(r, 500); });
    continueBtn1 = findContinueButton(false);
    if (!continueBtn1) {
        return { success: false, error: 'First continue button 500ms state wait ke baad nahi mila.', logs: diagnosticLogs };
    }
    continueBtn1.click();
    diagnosticLogs.push('First Continue button clicked.');
}

function getIRCTCErrorStatus(text) {
    var lowerText = String(text || '').toLowerCase();
    if (lowerText.includes('high load')) return { step: 'HIGH LOAD', message: 'HIGH LOAD' };
    if (lowerText.includes('unable to process request') || lowerText.includes('unable to process the request') || lowerText.includes('unable to process')) {
        return { step: 'UNABLE TO PROCESS REQUEST', message: 'unable to process request' };
    }
    if (lowerText.includes('please retry')) return { step: 'PLEASE RETRY', message: 'please retry' };
    return { step: 'BOOKING ERROR', message: 'IRCTC booking error' };
}

// FIRST CONTINUE RETRY (WEB / WEB2 / WEB3)
if (!isFirefoxWEB4PaymentCalculateFare) {
    var firstRetry = 0;
    var firstRetryLimit = 20;
    var firstWaitCycles = 0;
    var firstWaitCycleLimit = 480;

    for (;;) {
        firstWaitCycles++;
        if (firstWaitCycles > firstWaitCycleLimit) {
            return { success: false, error: 'First Continue page response timeout.', logs: diagnosticLogs };
        }
        await new Promise(function(r) { setTimeout(r, 500); });

        var firstContinuePageText = String(document.body && document.body.innerText || '');
        var insufficientBerthPopup =
            /insufficient number of required berth/i.test(firstContinuePageText) &&
            /\b(?:TQWL|GNWL|RLWL|PQWL|RQWL|RSWL|WL)\s*\d+\s*\/\s*(?:WL\s*)?\d+\b/i.test(firstContinuePageText);

        if (insufficientBerthPopup) {
            diagnosticLogs.push('NO SEAT AVAILABLE: IRCTC waitlist confirmation detected. Booking stopped.');
            await liveProgress('NO SEAT AVAILABLE', 'NO SEAT AVAILABLE', 0);
            return { success: false, cancelled: true, error: 'NO SEAT AVAILABLE', logs: diagnosticLogs };
        }

        var currentPageText = firstContinuePageText.replace(/\s+/g, ' ').toLowerCase();
        var reviewPage = currentPageText.includes('review journey') || currentPageText.includes('review your journey');
        var wait = currentPageText.includes('please wait') || currentPageText.includes('processing') || currentPageText.includes('loading');

        // Review Journey page aate hi aur loader hatne par success
        if (reviewPage && !wait && !/high load|unable to process|please retry/i.test(currentPageText)) {
            diagnosticLogs.push("Review Journey page detected and loader finished. First Continue successful.");
            break;
        }

        var popup = /high load|unable to process|please retry/i.test(currentPageText);
        if (popup) {
            firstRetry++;
            diagnosticLogs.push("First Continue error popup. Retry " + firstRetry + "/" + firstRetryLimit);
            var detectedError = getIRCTCErrorStatus(firstContinuePageText);
            var firstErrorLabel = /high load/i.test(firstContinuePageText) ? 'HIGHLOAD' : 'UNABLE TO PROCESS';
            await liveProgress(
                detectedError.step,
                firstErrorLabel + ' ERROR: (RETRY ' + firstRetry + ' / ' + firstRetryLimit + ')',
                20
            );

            closeAnyIRCTCErrors();

            if (firstRetry > firstRetryLimit) {
                return { success: false, error: 'First Continue failed after 20 retries.', logs: diagnosticLogs };
            }

            // 2 second wait taaki toast clear ho aur button enable ho sake
            await new Promise(function(r) { setTimeout(r, 4500); });
            closeAnyIRCTCErrors();

            var retryBtn1 = findContinueButton(false);
            if (retryBtn1) {
                retryBtn1.click();
                diagnosticLogs.push("First Continue retry clicked (" + firstRetry + "/" + firstRetryLimit + ").");
            } else {
                diagnosticLogs.push("First Continue button not ready yet; will click on next cycle.");
            }
            continue;
        }

        // Agar error nahi hai lekin Continue button disabled/stuck hai aur review page nahi aaya
        var stuckContinueBtn1 = findContinueButton(false);
        if (stuckContinueBtn1 && !wait && firstWaitCycles % 10 === 0) {
            stuckContinueBtn1.click();
            diagnosticLogs.push("First Continue re-clicked (waiting for Review Journey page).");
        }
    }
}

// SECOND CONTINUE
diagnosticLogs.push("First Continue processing complete. Searching next Continue...");
var continueBtn2 = null;
var secondFindRetry = 0;
var secondFindLimit = 60;
var secondFindWaitCycles = 0;
var secondFindWaitCycleLimit = 400;

for (;;) {
    secondFindWaitCycles++;
    if (secondFindWaitCycles > secondFindWaitCycleLimit) {
        return { success: false, error: 'Second Continue search timeout.', logs: diagnosticLogs };
    }
    await new Promise(function(r) { setTimeout(r, 250); });

    var txt2 = (document.body.innerText || '').toLowerCase();
    var popup2 = /high load|unable to process|please retry/i.test(txt2);
    if (popup2) {
        secondFindRetry++;
        diagnosticLogs.push("Second Continue search error. Retry " + secondFindRetry + "/" + secondFindLimit);
        var detectedError2 = getIRCTCErrorStatus(document.body.innerText || '');
        await liveProgress(detectedError2.step, detectedError2.message, 20);
        closeAnyIRCTCErrors();
        await new Promise(function(r) { setTimeout(r, 4500); });

        if (secondFindRetry >= secondFindLimit) {
            return { success: false, error: 'Second Continue button nahi mila after retries.', logs: diagnosticLogs };
        }
        continue;
    }

    continueBtn2 = findContinueButton(false);
    if (continueBtn2) break;
}

var reviewPageText = document.body.innerText || '';
var isReviewPage = /passenger\s+(?:details|information)/i.test(reviewPageText);
var wlMatch = isReviewPage
    ? reviewPageText.match(/\b((?:TQWL|GNWL|RLWL|PQWL|RQWL|RSWL|WL)\s*\d+\s*\/\s*(?:WL\s*)?\d+)\b/i)
    : null;
if (wlMatch) {
    var detectedWL = wlMatch[1].replace(/\s+/g, '');
    if (typeof window.__bossRequestWLDecision !== 'function') {
        return { success: false, cancelled: true, error: 'WL confirmation popup bridge missing. Booking stopped.', logs: diagnosticLogs };
    }
    var wlDecision = 'cancel';
    try { wlDecision = await window.__bossRequestWLDecision(detectedWL); } catch (_) {}
    if (wlDecision !== 'proceed') {
        return { success: false, cancelled: true, error: 'Booking cancelled by user at WL confirmation.', logs: diagnosticLogs };
    }
}

var isWEB4SecondContinue =
    String(payload.browserType || '').trim().toUpperCase() === 'WEB4';

continueBtn2.click();
diagnosticLogs.push("Second Continue button clicked.");

// SECOND CONTINUE RETRY - MAXIMUM 20 RETRIES
var secondRetry = 0;
var secondRetryLimit = 20;
var secondWaitCycles = 0;
var secondWaitCycleLimit = 480;

for (;;) {
    secondWaitCycles++;
    if (secondWaitCycles > secondWaitCycleLimit) {
        return { success: false, error: 'Second Continue processing timeout.', logs: diagnosticLogs };
    }
    await new Promise(function(r) { setTimeout(r, 500); });

    var txt3 = (document.body.innerText || '').toLowerCase();
    var web4SecondToastError = isWEB4SecondContinue ? getWEB4ToastError().toLowerCase() : '';
    var popup3 =
        (isWEB4SecondContinue && /high load|unable to process|please retry/i.test(web4SecondToastError)) ||
        (!isWEB4SecondContinue && /high load|unable to process|please retry/i.test(txt3));

    if (popup3) {
        secondRetry++;
        diagnosticLogs.push("Second Continue error popup. Retry " + secondRetry + "/" + secondRetryLimit);
        var detectedError3 = getIRCTCErrorStatus(document.body.innerText || '');
        var secondErrorSource = isWEB4SecondContinue ? web4SecondToastError : txt3;
        var secondErrorLabel = /high load/i.test(secondErrorSource) ? 'HIGHLOAD' : 'UNABLE TO PROCESS';
        await liveProgress(
            detectedError3.step,
            secondErrorLabel + ' ERROR: (RETRY ' + secondRetry + ' / ' + secondRetryLimit + ')',
            20
        );

        if (secondRetry > secondRetryLimit) {
            return { success: false, error: 'Second Continue failed after 20 retries.', logs: diagnosticLogs };
        }

        closeAnyIRCTCErrors();

        // 2 second wait taaki toast clear ho aur button dubara active ho sake
        await new Promise(function(r) { setTimeout(r, 4500); });
        closeAnyIRCTCErrors();

        var retryBtn2 = findContinueButton(isWEB4SecondContinue);
        if (retryBtn2) {
            retryBtn2.click();
            diagnosticLogs.push("Second Continue retry click successful: " + secondRetry + "/" + secondRetryLimit);
        } else {
            diagnosticLogs.push("Second Continue button not ready yet; will retry on next cycle.");
        }
        continue;
    }

    if (txt3.includes('please wait') || txt3.includes('processing')) {
        continue;
    }

    // Agar payment page / multiple payment service / bank-card / pay & book elements dikhne lage to aage badho
    var paymentScreenReady =
        document.querySelector('.bank-type') ||
        document.querySelector('button.bank-card') ||
        Array.from(document.querySelectorAll('button, a')).some(function(el) {
            var elTxt = (el.innerText || el.textContent || '').trim().toLowerCase();
            return elTxt.indexOf('pay & book') !== -1 || elTxt.indexOf('make payment') !== -1;
        });

    if (paymentScreenReady) {
        break;
    }

    // Agar abhi bhi Review page par Continue button dikh raha hai aur processing nahi chal rahi, to retry click karein
    var stillOnReviewBtn = findContinueButton(isWEB4SecondContinue);
    if (stillOnReviewBtn && secondWaitCycles % 10 === 0) {
        stillOnReviewBtn.click();
        diagnosticLogs.push("Second Continue re-clicked (waiting for payment page).");
    }
}
            await liveProgress('PAYMENT', 'INITILIZE PAYMENT.....', 70);

            var selectedPayment = String(payload.payment || payload.paymentType || payload.paymentMethod || '').trim().toUpperCase();
            if (!selectedPayment) {
                return { success: false, error: 'Payment type payload mein empty hai.', logs: diagnosticLogs };
            }

            var paymentIsPaytm = selectedPayment === 'PAYTM QR' || selectedPayment === 'PAYTMQR' || selectedPayment.indexOf('PAYTM') === 0;
            var paymentIsPhonePe = selectedPayment === 'PHONEPE QR' || selectedPayment === 'PHONEPEQR' || selectedPayment.indexOf('PHONEPE') === 0;
            var paymentIsRazorpay = selectedPayment === 'RAZORPAY QR' || selectedPayment === 'RAZORPAYQR' || selectedPayment.indexOf('RAZORPAY') === 0;

            if (!paymentIsPaytm && !paymentIsPhonePe && !paymentIsRazorpay) {
                return { success: false, error: 'Unknown payment type: ' + selectedPayment, logs: diagnosticLogs };
            }

            var providerName = paymentIsPaytm ? 'PAYTM' : paymentIsPhonePe ? 'PHONEPE' : 'RAZORPAY';
            var isFirefoxWEB4Payment = String(payload.browserType || '').trim().toUpperCase() === 'WEB4';
            var web4PaymentAlt = paymentIsPaytm ? 'Paytm' : paymentIsPhonePe ? 'PhonePe' : 'Razorpay';

            if (!isFirefoxWEB4Payment) {
                var multiplePaymentService = null;
                var multiPaymentDeadline = Date.now() + 60000;
                while (Date.now() < multiPaymentDeadline) {
                    multiplePaymentService = Array.from(document.querySelectorAll('.bank-type')).find(function(el) {
                        if (!el || !el.isConnected || el.offsetParent === null) return false;
                        if (String(el.getAttribute('aria-disabled') || '').trim().toLowerCase() === 'true') return false;
                        var txt = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
                        return txt.indexOf('MULTIPLE PAYMENT SERVICE') !== -1;
                    });
                    if (multiplePaymentService) break;
                    await new Promise(function(resolve) { setTimeout(resolve, 250); });
                }
                if (!multiplePaymentService) {
                    return { success: false, error: 'Multiple Payment Service option 60 seconds mein nahi mila.', logs: diagnosticLogs };
                }

                function isMultiplePaymentServiceActive(el) {
                    if (!el || !el.isConnected) return false;
                    var cls = String(el.className || '').toLowerCase();
                    return (
                        cls.indexOf('bank-type-active') !== -1 ||
                        cls.indexOf('selected') !== -1 ||
                        cls.indexOf('active') !== -1 ||
                        String(el.getAttribute('aria-selected') || '').toLowerCase() === 'true' ||
                        String(el.getAttribute('aria-checked') || '').toLowerCase() === 'true'
                    );
                }

                if (!isMultiplePaymentServiceActive(multiplePaymentService)) {
                    try { multiplePaymentService.scrollIntoView({ behavior: 'auto', block: 'center' }); } catch (_) {}
                    multiplePaymentService.click();
                }

                var multiVerifyDeadline = Date.now() + 60000;
                while (Date.now() < multiVerifyDeadline) {
                    var freshMulti = Array.from(document.querySelectorAll('.bank-type')).find(function(el) {
                        if (!el || !el.isConnected || el.offsetParent === null) return false;
                        return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase().indexOf('MULTIPLE PAYMENT SERVICE') !== -1;
                    });
                    if (freshMulti && isMultiplePaymentServiceActive(freshMulti)) break;
                    await new Promise(function(resolve) { setTimeout(resolve, 250); });
                }
            }

            var providerElement = null;
            var providerDeadline = Date.now() + 60000;
            while (Date.now() < providerDeadline) {
                var providerElements = Array.from(document.querySelectorAll('.border-all.link, .col-pad a, .col-pad button, .bank-type'));
                function isUsableProviderElement(el) {
                    if (!el || !el.isConnected || el.offsetParent === null || el.disabled === true) return false;
                    return String(el.getAttribute('aria-disabled') || '').trim().toLowerCase() !== 'true';
                }

                if (isFirefoxWEB4Payment) {
                    providerElement = Array.from(document.querySelectorAll('button.bank-card[aria-label]')).find(function(btn) {
                        if (!btn || !btn.isConnected || btn.offsetParent === null || btn.disabled === true) return false;
                        return String(btn.getAttribute('aria-label') || '').trim().toUpperCase() === web4PaymentAlt.toUpperCase();
                    }) || null;
                } else {
                    providerElement = providerElements.find(function(el) {
                        if (!isUsableProviderElement(el)) return false;
                        return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase() === providerName;
                    }) || providerElements.find(function(el) {
                        if (!isUsableProviderElement(el)) return false;
                        var txt = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
                        return txt.indexOf(providerName) !== -1 && txt.length <= 80;
                    });
                }
                if (providerElement) break;
                await new Promise(function(resolve) { setTimeout(resolve, 250); });
            }

            if (!providerElement) {
                return { success: false, error: 'Side mein ' + providerName + ' option nahi mila.', logs: diagnosticLogs };
            }

            try { providerElement.scrollIntoView({ behavior: 'auto', block: 'center' }); } catch (_) {}
            providerElement.click();
            await new Promise(function(resolve) { setTimeout(resolve, 50); });

            if (isFirefoxWEB4Payment) {
                var web4SelectionConfirmed = false;
                var web4SelectionDeadline = Date.now() + 5000;
                while (Date.now() < web4SelectionDeadline) {
                    if (providerElement && providerElement.isConnected && String(providerElement.getAttribute('aria-pressed') || '').toLowerCase() === 'true') {
                        web4SelectionConfirmed = true;
                        break;
                    }
                    await new Promise(function(resolve) { setTimeout(resolve, 200); });
                }
                if (!web4SelectionConfirmed) {
                    throw new Error('WEB4: ' + web4PaymentAlt + ' click hua, lekin selection confirm nahi hua.');
                }
            }

            var payAndBookBtn = null;
            async function reselectRequestedPayment() {
                if (!isFirefoxWEB4Payment) {
                    var multiOption = Array.from(document.querySelectorAll('.bank-type')).find(function(el) {
                        if (!el || !el.isConnected || el.offsetParent === null) return false;
                        return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase().includes('MULTIPLE PAYMENT SERVICE');
                    });
                    if (multiOption) {
                        multiOption.click();
                        await new Promise(function(r) { setTimeout(r, 400); });
                    }
                }
                var wantedProvider = String(providerName || '').replace(/\s+/g, ' ').trim().toUpperCase();
                var retryProvider = isFirefoxWEB4Payment
                    ? Array.from(document.querySelectorAll('button.bank-card[aria-label]')).find(function(btn) {
                        return btn && btn.isConnected && btn.offsetParent !== null && !btn.disabled &&
                               String(btn.getAttribute('aria-label') || '').trim().toUpperCase() === web4PaymentAlt.toUpperCase();
                    })
                    : Array.from(document.querySelectorAll('.border-all.link, .col-pad a, .col-pad button, .bank-type')).find(function(el) {
                        if (!el || !el.isConnected || el.offsetParent === null || el.disabled === true) return false;
                        var txt = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
                        return txt === wantedProvider || (wantedProvider.length > 0 && txt.includes(wantedProvider) && txt.length <= 80);
                    });
                if (!retryProvider) return false;
                retryProvider.click();
                await new Promise(function(r) { setTimeout(r, 500); });
                return true;
            }

            var payBookRetry = 0;
            var payBookRetryLimit = 10;
            for (;;) {
                if (payBookRetry > 0) {
                    var paymentReselected = await reselectRequestedPayment();
                    if (!paymentReselected) {
                        return { success: false, error: 'Retry mein selected payment provider dobara select nahi hua.', logs: diagnosticLogs };
                    }
                }

                var payBookDeadline = Date.now() + 60000;
                payAndBookBtn = null;
                while (Date.now() < payBookDeadline) {
                    payAndBookBtn = Array.from(document.querySelectorAll('button, a, [role="button"]')).find(function(button) {
                        if (!button || !button.isConnected || button.offsetParent === null || button.disabled === true) return false;
                        if (String(button.getAttribute('aria-disabled') || '').trim().toLowerCase() === 'true') return false;
                        var text = String(button.innerText || button.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                        return text.indexOf('pay & book') !== -1 || text.indexOf('make payment') !== -1;
                    });
                    if (payAndBookBtn) break;
                    await new Promise(function(resolve) { setTimeout(resolve, 250); });
                }

                if (!payAndBookBtn) {
                    return { success: false, error: 'Pay & Book button nahi mila.', logs: diagnosticLogs };
                }

                try { payAndBookBtn.scrollIntoView({ behavior: 'auto', block: 'center' }); } catch (_) {}
                payAndBookBtn.click();
                diagnosticLogs.push("Pay & Book click sent. Checking payment page...");

                var payBookRetryAlreadyCounted = false;
                var payBookSuccess = false;
                var payWaitDeadline = Date.now() + 60000;
                while (Date.now() < payWaitDeadline) {
                    await new Promise(function(resolve) { setTimeout(resolve, 250); });
                    var payText = (document.body.innerText || '').toLowerCase();
                    if (payText.includes('high load') || payText.includes('unable to process') || payText.includes('please retry')) {
                        payBookRetryAlreadyCounted = true;
                        payBookRetry++;
                        var detectedError = getIRCTCErrorStatus(document.body.innerText || '');
                        await liveProgress(detectedError.step, detectedError.message, 20);
                        var payClose = document.querySelector('a.ui-toast-close-icon.pi.pi-times');
                        if (payClose) {
                            try { payClose.click(); } catch (_) {}
                        }
                        if (payBookRetry >= payBookRetryLimit) {
                            return { success: false, error: 'Pay & Book failed after ' + payBookRetryLimit + ' retries.', logs: diagnosticLogs };
                        }
                        await new Promise(function(resolve) { setTimeout(resolve, 300); });
                        break;
                    }

                    var actualQrReady = false;
                    if (paymentIsPaytm) {
                        var paytmImage = document.querySelector('img[data-key="qr-code"]');
                        actualQrReady = !!(paytmImage && paytmImage.isConnected && paytmImage.offsetParent !== null && paytmImage.complete && paytmImage.naturalWidth >= 100 && paytmImage.naturalHeight >= 100);
                    } else if (paymentIsPhonePe) {
                        var phonepeCandidates = Array.from(document.querySelectorAll('img[src*="qr" i], img[alt*="qr" i], img[src^="blob:"], canvas'));
                        actualQrReady = phonepeCandidates.some(function(el) {
                            if (!el.isConnected || el.offsetParent === null) return false;
                            if (el instanceof HTMLImageElement) return el.complete && el.naturalWidth >= 100 && el.naturalHeight >= 100;
                            return el instanceof HTMLCanvasElement && el.width >= 100 && el.height >= 100;
                        });
                    } else if (paymentIsRazorpay) {
                        var razorpayCandidates = Array.from(document.querySelectorAll('img[alt="UPI QR Code"], img[alt*="qr" i], img[src*="qr" i], img[src^="blob:"], img[src^="data:image/"], canvas'));
                        actualQrReady = razorpayCandidates.some(function(el) {
                            if (!el || !el.isConnected) return false;
                            var rect = el.getBoundingClientRect();
                            var style = window.getComputedStyle(el);
                            var visible = rect.width >= 100 && rect.height >= 100 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
                            if (!visible) return false;
                            if (el instanceof HTMLImageElement) return el.complete && el.naturalWidth >= 100 && el.naturalHeight >= 100;
                            if (el instanceof HTMLCanvasElement) return el.width >= 100 && el.height >= 100;
                            return false;
                        });
                    }

                    if (actualQrReady) {
                        payBookSuccess = true;
                        break;
                    }
                }

                if (payBookSuccess) {
                    return {
                        success: true,
                        paymentMethod: selectedPayment,
                        totalFare: payload.realFare,
                        logs: diagnosticLogs,
                        message: 'Pay & Book clicked successfully.'
                    };
                }

                if (payBookRetryAlreadyCounted) {
                    if (payBookRetry >= payBookRetryLimit) {
                        return { success: false, error: 'Pay & Book failed after ' + payBookRetryLimit + ' retries.', logs: diagnosticLogs };
                    }
                    await new Promise(function(resolve) { setTimeout(resolve, 1500); });
                    continue;
                }

                return {
                    success: false,
                    error: 'Pay & Book ke baad QR ya recognized error detect nahi hua.',
                    logs: diagnosticLogs
                };
            }
        } catch (automationError) {
            diagnosticLogs.push(
                "Browser automation fatal error: " +
                (automationError && automationError.message ? automationError.message : String(automationError))
            );
            return {
                success: false,
                error: automationError && automationError.message ? automationError.message : String(automationError),
                logs: diagnosticLogs
            };
        }
    };

    const script = `(${browserSideAutomationTask.toString()})('${base64Payload}')`;
    let result;
    if (!this.page || this.page.isClosed()) {
        throw new Error(`[${this.browserType}] External browser page available nahi hai.`);
    }

    if (this._wlConfirmationBridgePage !== this.page) {
        await this.page.exposeFunction('__bossRequestWLDecision', async (wlNumber) => {
            if (!this.qrCallbacks || typeof this.qrCallbacks.requestWLDecision !== 'function') return 'cancel';
            try {
                const decision = await this.qrCallbacks.requestWLDecision(wlNumber);
                return decision === 'proceed' ? 'proceed' : 'cancel';
            } catch (_) {
                return 'cancel';
            }
        });
        this._wlConfirmationBridgePage = this.page;
    }

    if (this._bookingProgressBridgePage !== this.page) {
        await this.page.exposeFunction('__bossSendProgress', (step, message, percentage) => {
            try { this.sendBookingStatus(message, step, percentage); } catch (_) {}
        });
        this._bookingProgressBridgePage = this.page;
    }

    if (this._avlFareBridgePage !== this.page) {
        await this.page.exposeFunction('__bossSendAvlFare', (availability, fare) => {
            try {
                if (fare && fare !== '--') bookingData.realFare = String(fare).replace(/[^\d.]/g, '');
                this.sendAvailabilityFare(availability, fare);
            } catch (_) {}
        });
        this._avlFareBridgePage = this.page;
    }

    if (typeof this.page.setDefaultTimeout === 'function') {
        this.page.setDefaultTimeout(0);
    }

    try {
        result = await this.page.evaluate(script);
    } catch (automationEvalError) {
        const errorMessage = String(automationEvalError?.message || automationEvalError);
        const navigationContextLost =
            /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed|Browsing context has been discarded|Document was unloaded|NS_BINDING_ABORTED/i
                .test(errorMessage);
        if (!navigationContextLost) throw automationEvalError;

        this.sendBookingStatus('VERIFYING PAYMENT PAGE...', 'Payment page load hone ka wait ho raha hai...', 75);
        let paymentPageState = null;
        const expectedPayment = String(bookingData.payment || bookingData.paymentType || bookingData.paymentMethod || '').trim().toUpperCase();
        if (!expectedPayment) throw new Error('Navigation recovery mein payment method nahi mila.');

        let razorpayShowQrClicked = false;
        const paymentVerificationDeadline = Date.now() + (5 * 60 * 1000);
        for (let i = 0; Date.now() < paymentVerificationDeadline; i++) {
            if (!this.page || this.page.isClosed()) break;
            try {
                if (!expectedPayment.startsWith('RAZORPAY')) {
                    await this.page.waitForFunction(
                        () => document.readyState === 'interactive' || document.readyState === 'complete',
                        { timeout: 3000 }
                    );
                }

                if (expectedPayment.startsWith('RAZORPAY') && !razorpayShowQrClicked) {
                    const browserPages = await this.page.browser().pages();
                    for (const candidatePage of browserPages) {
                        if (candidatePage.isClosed() || !candidatePage.url().includes('razorpay.com')) continue;
                        for (const frame of candidatePage.frames()) {
                            try {
                                const clickedQr = await frame.evaluate(() => {
                                    const el =
                                        document.querySelector('span[name="generateQR"]') ||
                                        Array.from(document.querySelectorAll('button, span, div')).find(node => {
                                            const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                                            const rect = node.getBoundingClientRect();
                                            const style = getComputedStyle(node);
                                            return text === 'show qr' && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
                                        });
                                    if (!el) return false;
                                    el.click();
                                    return true;
                                });
                                if (clickedQr) {
                                    for (let attempt = 0; attempt < 50; attempt++) {
                                        const clickedContinue = await frame.evaluate(() => {
                                            const btn =
                                                document.querySelector('button[data-testid="fee-bearer-cta"]') ||
                                                Array.from(document.querySelectorAll('button')).find(b => {
                                                    const text = (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                                                    const rect = b.getBoundingClientRect();
                                                    const style = getComputedStyle(b);
                                                    return (text.includes('continue & pay') || text.includes('continue and pay')) && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !b.disabled;
                                                });
                                            if (!btn) return false;
                                            btn.click();
                                            return true;
                                        });
                                        if (clickedContinue) break;
                                        await new Promise(resolve => setTimeout(resolve, 100));
                                    }
                                    razorpayShowQrClicked = true;
                                    break;
                                }
                            } catch (_) {}
                        }
                        if (razorpayShowQrClicked) break;
                    }
                }

                if (expectedPayment.startsWith('RAZORPAY')) {
                    const browserPages = await this.page.browser().pages();
                    for (const candidatePage of browserPages) {
                        if (candidatePage.isClosed() || !candidatePage.url().startsWith('https://checkout-hosted.razorpay.com/orders/')) continue;
                        const frameChecks = candidatePage.frames().map(async (frame) => {
                            let timeoutId;
                            try {
                                return await Promise.race([
                                    frame.evaluate(() => {
                                        for (const selector of ['img[alt*="qr" i]', 'img[src*="qr" i]', 'img[src^="blob:"]', 'canvas']) {
                                            for (const el of document.querySelectorAll(selector)) {
                                                const rect = el.getBoundingClientRect();
                                                const style = getComputedStyle(el);
                                                const visible = rect.width >= 100 && rect.height >= 100 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
                                                if (!visible) continue;
                                                if (el instanceof HTMLImageElement && el.complete && el.naturalWidth >= 100 && el.naturalHeight >= 100) return true;
                                                if (el instanceof HTMLCanvasElement && el.width >= 100 && el.height >= 100) return true;
                                            }
                                        }
                                        return false;
                                    }),
                                    new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('timeout')), 700); })
                                ]);
                            } catch (_) {
                                return false;
                            } finally {
                                clearTimeout(timeoutId);
                            }
                        });
                        const firstQr = await Promise.any(frameChecks.map(async c => { if (!await c) throw new Error(); return true; })).catch(() => false);
                        if (firstQr) {
                            paymentPageState = { url: candidatePage.url(), ready: 'complete', text: '', actualQrReady: true, qrType: 'RAZORPAY QR' };
                            break;
                        }
                    }
                    if (paymentPageState) break;
                }

                const state = await this.page.evaluate((expectedPayment) => {
                    function validImage(el) {
                        return !!(el && el.isConnected && el.offsetParent !== null && el.complete && el.naturalWidth >= 100 && el.naturalHeight >= 100);
                    }
                    let actualQrReady = false;
                    let qrType = '';
                    let phonePeUrlVerified = false;
                    if (expectedPayment.startsWith('PAYTM')) {
                        actualQrReady = validImage(document.querySelector('img[data-key="qr-code"]'));
                        if (actualQrReady) qrType = 'PAYTM QR';
                    } else if (expectedPayment.startsWith('RAZORPAY')) {
                        actualQrReady = validImage(document.querySelector('img[alt="UPI QR Code"]'));
                        if (actualQrReady) qrType = 'RAZORPAY QR';
                    } else if (expectedPayment.startsWith('PHONEPE')) {
                        try {
                            const currentUrl = new URL(window.location.href);
                            phonePeUrlVerified = currentUrl.protocol === 'https:' && currentUrl.hostname === 'mercury-t2.phonepe.com' && currentUrl.pathname === '/transact/sltv3' && Boolean(currentUrl.searchParams.get('token'));
                        } catch (_) { phonePeUrlVerified = false; }
                        const qrReady = Array.from(document.querySelectorAll('img[src*="qr" i], img[alt*="qr" i], img[src^="blob:"], canvas')).some(el => {
                            if (!el.isConnected) return false;
                            const style = window.getComputedStyle(el);
                            const rect = el.getBoundingClientRect();
                            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0) return false;
                            if (el instanceof HTMLImageElement) return el.complete && el.naturalWidth >= 100 && el.naturalHeight >= 100;
                            return el instanceof HTMLCanvasElement && el.width >= 100 && el.height >= 100;
                        });
                        actualQrReady = phonePeUrlVerified && qrReady;
                        if (actualQrReady) qrType = 'PHONEPE QR';
                    }
                    return {
                        url: window.location.href,
                        ready: document.readyState,
                        text: String(document.body?.innerText || '').slice(0, 15000),
                        actualQrReady,
                        qrType,
                        providerUrlVerified: phonePeUrlVerified
                    };
                }, expectedPayment);

                const hasIrctcError = /high load|unable to process|please retry/i.test(state.text);
                if (state.ready !== 'loading' && !hasIrctcError && state.actualQrReady && (!expectedPayment.startsWith('PHONEPE') || state.providerUrlVerified === true)) {
                    paymentPageState = state;
                    break;
                }
            } catch (_) {}
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        if (!paymentPageState) {
            throw new Error('Navigation ke baad selected provider ka actual QR 5 minutes mein verify nahi hua.');
        }

        result = {
            success: true,
            paymentMethod: expectedPayment,
            totalFare: backendRealFare,
            logs: ['Navigation detect hui.', 'Actual provider QR verify hua: ' + paymentPageState.qrType],
            message: 'Actual payment QR verified after navigation.'
        };
    }

    this.sendBookingStatus('QR DETECTING...', 'QR DETECTING', 78);
    console.log('\n================ AUTOMATION LOGS ===============');
    if (result && result.logs) {
        result.logs.forEach(log => console.log('  -> ' + log));
    }
    console.log('================================================\n');

    if (!result || !result.success) {
        throw new Error(`Automation stopped: ${result?.error || 'Unknown error'}`);
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
// PRE-LOGIN AVAILABILITY & FARE
await this.checkPreLoginAvailabilityFromUI(bookingData);

// RESTORE SAVED SESSION IF NEEDED
await this.autoRestoreSession();

// EXISTING AUTO LOGIN / SESSION CHECK
await this.autoLogin(username, password);

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
    let qrImage = this._lastRazorpayQrImage || null;
    let qrElement = null;
    let qrReady = Boolean(this._instantRazorpaySent && qrImage);

    if (!this._instantRazorpaySent) {
        // WAIT FOR QR TO ACTUALLY LOAD
        const qrDeadline = Date.now() + 60000;
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
// READ ACTUAL PAYTM PAYMENT AMOUNT (ONLY FOR PAYTM)
let qrAmount = null;
if (paymentValue.startsWith('PAYTM')) {
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
                } catch (_) {}
            }
            if (qrAmount) break;
        }
        console.log('[QR] Actual payment amount:', qrAmount || 'Not found');
    } catch (amountError) {
        console.warn('[QR] Payment amount read failed:', amountError.message);
    }
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