// =====================================================================
//  KONFIGURASI FIREBASE (project: opjweaponstore)
//  Config ini BUKAN rahasia. Keamanan data dijaga oleh Firestore Rules.
// =====================================================================
export const firebaseConfig = {
  apiKey: "AIzaSyCPnZYCmliRcVirhAN1fGMCxHqq72ZtGdY",
  authDomain: "opjweaponstore.firebaseapp.com",
  projectId: "opjweaponstore",
  storageBucket: "opjweaponstore.firebasestorage.app",
  messagingSenderId: "668573730841",
  appId: "1:668573730841:web:07435c5188a5b0ad190288"
};

// Email akun admin di Firebase Authentication.
// Harus SAMA dengan email di Authentication > Users dan di firestore.rules.
export const ADMIN_EMAIL = "admin@tactical-armory.app";