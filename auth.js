const { getAuthToken } = require('@heyputer/puter.js/src/init.cjs');

(async () => {
  console.log('🌐 Opening browser for Puter login...');
  console.log('👉 Log in / sign up at puter.com in the browser window');
  console.log('⏳ Waiting for auth...\n');
  
  try {
    const token = await getAuthToken('https://puter.com');
    console.log('✅ Auth token received!\n');
    console.log('Add this to your .env file:');
    console.log(`PUTER_AUTH_TOKEN=${token}`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Auth failed:', err.message);
    process.exit(1);
  }
})();
