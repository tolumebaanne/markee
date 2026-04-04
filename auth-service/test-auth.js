const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/register',
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
  },
};

const req = http.request(options, (res) => {
  console.log('Registration Status:', res.statusCode);
  console.log('Headers:', res.headers);
  const cookie = res.headers['set-cookie'] ? res.headers['set-cookie'][0].split(';')[0] : '';
  
  if (res.statusCode === 302 && res.headers.location.includes('success')) {
    console.log('STEP 5 OK (Registration)');
    
    // Test Login
    const loginReq = http.request({ ...options, path: '/login', headers: { ...options.headers, 'Cookie': cookie } }, (loginRes) => {
      console.log('Login Status:', loginRes.statusCode);
      const newCookie = loginRes.headers['set-cookie'] ? loginRes.headers['set-cookie'][0].split(';')[0] : cookie;
      
      if (loginRes.statusCode === 302) {
        console.log('STEP 6 OK (Login redirect)');
        
        // Test Session
        http.get({ hostname: 'localhost', port: 3000, path: '/', headers: { 'Cookie': newCookie } }, (homeRes) => {
          let data = '';
          homeRes.on('data', chunk => data += chunk);
          homeRes.on('end', () => {
            if (data.includes('Welcome, testuser2!')) {
              console.log('STEP 7 OK (Session persistence)');
              
              // Verify DB
              require('dotenv').config();
              const { MongoClient } = require('mongodb');
              (async () => {
                const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/oauth_auth_server');
                await client.connect();
                const user = await client.db().collection('users').findOne({username: 'testuser2'});
                if (user && user.password.startsWith('$2b$')) {
                  console.log('DB VERIFY OK');
                  await client.db().collection('users').deleteOne({username: 'testuser2'}); // cleanup
                } else {
                  console.log('DB VERIFY FAILED');
                }
                await client.close();
                process.exit(0);
              })();
            } else {
              console.log('STEP 7 FAILED (Cannot find welcome text)');
            }
          });
        });
      }
    });
    loginReq.write('username=testuser2&password=password123');
    loginReq.end();
  } else {
     console.log('STEP 5 FAILED. It might be that testuser already exists from a previous run.');
  }
});

req.on('error', (e) => {
  console.error(`Problem with request: ${e.message}`);
});

req.write('username=testuser2&password=password123&email=test2@example.com');
req.end();
