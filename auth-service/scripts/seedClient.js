require('dotenv').config();
const { connectDB, getDB, closeDB } = require('../config/db');
const Client = require('../models/Client');

async function seedClient() {
  try {
    await connectDB();
    
    const existingClient = await Client.findByClientId('test_client_app');
    if (existingClient) {
      console.log('Test client already exists');
      await closeDB();
      return;
    }

    const client = await Client.create({
      client_id: 'test_client_app',
      client_secret: 'test_client_secret_min_32_chars',
      name: 'Test Client Application',
      redirect_uris: ['http://localhost:4000/callback']
    });

    console.log('Test client created successfully');
    console.log('Client ID:', client.client_id);
    console.log('Client Secret:', client.client_secret);
    console.log('Redirect URIs:', client.redirect_uris.join(', '));
    
    await closeDB();
  } catch (error) {
    console.error('Error seeding client:', error);
    process.exit(1);
  }
}

seedClient();
