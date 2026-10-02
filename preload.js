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

getBrowserStatuses: () =>
    ipcRenderer.invoke('get-browser-statuses'),

prepareBrowsers: () =>
    ipcRenderer.invoke('prepare-browsers'),

        // ==========================================
        // NORMAL BOOKING
        // ==========================================

        startBooking: (
            bookingData,
            targetBrowser
        ) =>
            ipcRenderer.invoke(
                'start-booking',
                bookingData,
                targetBrowser
            ),

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
// AUTO UPDATE
// ==========================================

onAppUpdateAvailable: (callback) =>
    ipcRenderer.on(
        'app-update-available',
        (
            event,
            data
        ) => callback(data)
    ),

onAppUpdateProgress: (callback) =>
    ipcRenderer.on(
        'app-update-progress',
        (
            event,
            data
        ) => callback(data)
    ),

onAppUpdateDownloaded: (callback) =>
    ipcRenderer.on(
        'app-update-downloaded',
        (
            event,
            data
        ) => callback(data)
    ),

    installAppUpdate: () =>
    ipcRenderer.send(
        'install-app-update'
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
            )

    }
);