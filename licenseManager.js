const { initializeApp } = require("firebase/app");
const { getDatabase, ref, get, update } = require("firebase/database");
const os = require('os');

// Aapke Firebase Console se praapt Config Details
const firebaseConfig = {
  apiKey: "AIzaSyDO2mMt_I9pfuLfsS9nUjreBezQugjxB7w",
  authDomain: "boicense.firebaseapp.com",
  databaseURL: "https://boicense-default-rtdb.firebaseio.com",
  projectId: "boicense",
  storageBucket: "boicense.firebasestorage.app",
  messagingSenderId: "541826909449",
  appId: "1:541826909449:web:78e70774de49246e783fd8",
  measurementId: "G-WCDNDNGQ75"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// Machine ka MAC Address (HWID) Extract karne ka Function
function getHardwareID() {
    const interfaces = os.networkInterfaces();
    for (let name in interfaces) {
        for (let net of interfaces[name]) {
            if (!net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
                return net.mac.toUpperCase();
            }
        }
    }
    return "UNKNOWN_HWID";
}

// Key Check & Auto-Binding Core Logic
async function verifyLicense(licenseKey) {
    if (!licenseKey) {
        return { success: false, message: "Kripya License Key enter karein!" };
    }

    try {
        const keyRef = ref(db, 'licenses/' + licenseKey.trim());
        const snapshot = await get(keyRef);

        // 1. Key Exist Check
        if (!snapshot.exists()) {
            return { success: false, message: "Galat ya invalid License Key!" };
        }

        const data = snapshot.val();
        const currentHWID = getHardwareID();
        const today = new Date().toISOString().split('T')[0];

        // 2. Status Check
        if (data.status === 'blocked') {
            return { success: false, message: "Aapka License Block kar diya gaya hai!" };
        }

        // 3. Expiry Check
        if (data.expiry_date < today) {
            return { success: false, message: "License Expire ho chuka hai!" };
        }

        // 4. Automatic First-Time HWID Binding Logic
        if (!data.hwid || data.hwid === "none" || data.hwid === "") {
            // First time login on this key: Bind machine HWID automatically
            await update(keyRef, { hwid: currentHWID });
        } else if (data.hwid !== currentHWID) {
            // Already bound to another machine
            return { success: false, message: "Ye Key kisi dusre PC par registered hai!" };
        }

        return { 
            success: true, 
            message: "License Successfully Activated!", 
            expiryDate: data.expiry_date 
        };

    } catch (error) {
        console.error("Firebase License Error:", error);
        return { success: false, message: "Network Error! Internet connection check karein." };
    }
}

module.exports = { verifyLicense, getHardwareID };