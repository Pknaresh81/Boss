const {
    contextBridge,
    ipcRenderer
} = require('electron');

contextBridge.exposeInMainWorld(
    'electronAPI',
    {

        // ==========================================
        // BROWSER
        // ==========================================

        openBrowser: (browserName) =>
            ipcRenderer.invoke(
                'open-selected-browser',
                browserName
            ),

            
clearBrowserData: (browserType) =>
    ipcRenderer.invoke(
        'clear-browser-data',
        browserType
    ),


getBrowserStatuses: () =>
    ipcRenderer.invoke('get-browser-statuses'),

prepareBrowsers: () =>
    ipcRenderer.invoke('prepare-browsers'),

        // ==========================================
        // NORMAL BOOKING
        // ==========================================

        startBooking: (
    bookingData,
    targetBrowser,
    windowId
) =>

    ipcRenderer.invoke(

        'start-booking',
        bookingData,
        targetBrowser,
        windowId

    ),


    // ==========================================
// WL CONFIRMATION BRIDGE
// ==========================================

onWLDecisionRequest: (callback) => {
    ipcRenderer.on('wl-decision-request', (_event, data) => {
        callback(data);
    });
},

sendWLDecision: (windowId, decision) => {
    return ipcRenderer.invoke(
        'wl-decision-response',
        {
            windowId,
            decision
        }
    );
},

        // ==========================================
        // TATKAL BOOKING
        // ==========================================

        startTatkalBooking: (payload) =>
            ipcRenderer.invoke(
                'start-tatkal-booking',
                payload
            ),

        // ==========================================
        // LOGIN
        // ==========================================

        startLogin: (
            payload = {}
        ) =>
            ipcRenderer.invoke(
                'start-login',
                payload
            ),

        // ==========================================
        // CAPTCHA
        // ==========================================

        solveCaptcha: (
            captchaImageSrc,
            browserType = 'WEB'
        ) =>
            ipcRenderer.invoke(
                'solve-captcha-interactively',
                captchaImageSrc,
                browserType
            ),

        submitCaptcha: (
            captcha,
            browserType = 'WEB'
        ) =>
            ipcRenderer.send(
                'submit-captcha-response',
                {
                    captcha,
                    browserType
                }
            ),

        cancelCaptcha: (
            browserType = 'WEB'
        ) =>
            ipcRenderer.send(
                'cancel-captcha-response',
                {
                    browserType
                }
            ),

        onShowCaptcha: (callback) =>
            ipcRenderer.on(
                'show-captcha-modal',
                (
                    event,
                    data
                ) => callback(data)
            ),

        // ==========================================
        // WINDOW
        // ==========================================

        resizeWindow: (size) =>
            ipcRenderer.send(
                'resize-window',
                size
            ),

        // ==========================================
        // LICENSE
        // ==========================================

        verifyLicenseKey: (licenseKey) =>
            ipcRenderer.invoke(
                'verify-license-key',
                licenseKey
            ),

        closeLicenseWindow: () =>
    ipcRenderer.send(
        'close-license-window'
    ),    

    completeLicenseActivation: () =>
    ipcRenderer.send(
        'complete-license-activation'
    ),

        // ==========================================
        // MINI AUTOMATION WINDOW
        // ==========================================

        openMiniAutomationWindow: (
            ticketData,
            ticketIndex
        ) =>
            ipcRenderer.invoke(
                'open-mini-automation-window',
                ticketData,
                ticketIndex
            ),

        closeMiniAutomationWindow: (
            windowId
        ) =>
            ipcRenderer.send(
                'close-mini-automation-window',
                windowId
            ),

        onMiniWindowData: (callback) =>
            ipcRenderer.on(
                'mini-window-data',
                (
                    event,
                    data
                ) => callback(data)
            ),

            onMiniWindowDataUpdate: (callback) =>
    ipcRenderer.on(
        'mini-window-data-update',
        (
            event,
            data
        ) => callback(data)
    ),

          
           onBookingLockUpdate: (callback) =>
            ipcRenderer.on(
                'booking-lock-update',
                (
                    event,
                    data
                ) => callback(data)
            ),

        onBookingProgress: (callback) =>
            ipcRenderer.on(
                'booking-progress',
                (
                    event,
                    data
                ) => callback(data)
            ),

              // ==========================================
        // QR PAYMENT POPUP
        // ==========================================

        onPaymentQR: (callback) =>
            ipcRenderer.on(
                'payment-qr-show',
                (
                    event,
                    data
                ) => callback(data)
            ),

        onPaymentQRHide: (callback) =>
            ipcRenderer.on(
                'payment-qr-hide',
                () => callback()
            ),

        onPaymentQRTimer: (callback) =>
            ipcRenderer.on(
                'payment-qr-timer',
                (
                    event,
                    data
                ) => callback(data)
            ),
            onPaymentQRTimer: (callback) =>
            ipcRenderer.on(
                'payment-qr-timer',
                (
                    event,
                    data
                ) => callback(data)
            ),

        // ==========================================
        // SEARCH ROUTE TRAINS (Naya Function)
        // ==========================================
        searchRouteTrains: (data) =>
            ipcRenderer.invoke(
                'search-route-trains',
                data
            ),
            
            
            irctcDevAvailability: (data) =>
    ipcRenderer.invoke(
        'irctcdev-availability',
        data
    ),

            // ==========================================
            // SECURE API KEY MANAGEMENT
            // ==========================================

            getApiKeyStatus: () =>
                ipcRenderer.invoke(
                    'api-keys:get-status'
                ),

            saveApiKeys: (values) =>
    ipcRenderer.invoke(
        'api-keys:save',
        {
            directApiSh: String(values?.directApiSh || ''),
            railCore: String(values?.railCore || ''),
            irctcDev: String(values?.irctcDev || '')
        }
    )
    }
);