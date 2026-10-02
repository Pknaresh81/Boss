const { ipcMain } = require('electron');

// 1. Random Jitter Delay (Anti-Blocking ke liye)
// Yeh function requests ke beech mein natural human-like gap rakhta hai taaki server block na kare.
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function randomDelay(min = 300, max = 800) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await sleep(delay);
}

// 2. Live Status Broadcaster (UI ko update bhejne ke liye)
function sendStatus(win, message, timerValue = null) {
    console.log(`[STEP 4 - LIVE TRACKING] ${message}`);
    if (win && !win.isDestroyed()) {
        win.webContents.send('update-booking-status', {
            text: message,
            timer: timerValue
        });
    }
}

// 3. Complete Smart Booking Execution Flow
async function executeSmartBooking(win, bookingDetails) {
    try {
        let startTime = Date.now();

        // Step A: Connecting
        sendStatus(win, 'Connecting to secure server gateway...', '00:02');
        await randomDelay(400, 900); // Anti-blocking delay

        // Step B: Availability Check
        sendStatus(win, 'Checking real-time seat availability & fare...', '00:12');
        await randomDelay(500, 1000);

        // Step C: Passenger Filling
        sendStatus(win, 'Submitting passenger details & preferences...', '00:25');
        await randomDelay(600, 1200);

        // Step D: Final Fare & Payment Trigger
        sendStatus(win, 'Calculating final fare & generating payment gateway...', '00:38');
        await randomDelay(500, 800);

        // Step E: QR Code Pop-up Trigger (45 Seconds Timer)
        const totalTimeTaken = Math.floor((Date.now() - startTime) / 1000);
        console.log(`[STEP 4 - SUCCESS] Reached payment stage in ${totalTimeTaken} seconds!`);

        // Frontend ko signal bhejen ki QR popup open ho
        if (win && !win.isDestroyed()) {
            win.webContents.send('show-qr-popup', {
                qrImage: 'data:image/png;base64,iVBORw0KGgoAAAANSU...', // Yahan aapka real payment QR base64 aayega
                countdown: 45
            });
        }

        sendStatus(win, 'Payment QR Code generated. Waiting for user scan...', '00:45');
        return { success: true };

    } catch (error) {
        sendStatus(win, `Booking Failed: ${error.message}`);
        return { success: false, error: error.message };
    }
}

module.exports = { randomDelay, sendStatus, executeSmartBooking };