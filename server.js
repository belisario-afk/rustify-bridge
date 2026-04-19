require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// Serve the frontend website from the "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// CONFIGURATION (Set via Render Environment Variables)
// ==========================================
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI; 
const RUST_SERVER_SECRET = process.env.RUST_SERVER_SECRET; 
const PORT = process.env.PORT || 3000;

// Database (Using a simple JSON file for Render free tier)
const DB_FILE = '/tmp/tokens.json'; // Render free tier clears /tmp/ on restart, but it works for testing!
let db = {};
if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE));
}
const saveDb = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

// ==========================================
// 1. OAUTH FLOW (Player links account)
// ==========================================
app.get('/auth/login', (req, res) => {
    const steamId = req.query.steamId;
    if (!steamId) return res.status(400).send('Missing Steam ID');

    const scope = 'user-modify-playback-state user-read-playback-state';
    res.redirect('https://accounts.spotify.com/authorize?' +
        querystring.stringify({
            response_type: 'code',
            client_id: SPOTIFY_CLIENT_ID,
            scope: scope,
            redirect_uri: REDIRECT_URI,
            state: steamId 
        })
    );
});

app.get('/auth/callback', async (req, res) => {
    const code = req.query.code || null;
    const steamId = req.query.state || null; 

    if (!code || !steamId) return res.status(400).send('Authorization failed.');

    try {
        const response = await axios.post('https://accounts.spotify.com/api/token', 
            querystring.stringify({
                code: code,
                redirect_uri: REDIRECT_URI,
                grant_type: 'authorization_code'
            }), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + (Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64'))
                }
            }
        );

        db[steamId] = {
            access_token: response.data.access_token,
            refresh_token: response.data.refresh_token,
            expires_at: Date.now() + (response.data.expires_in * 1000)
        };
        saveDb();

        res.send('<body style="background:#121212;color:white;font-family:sans-serif;text-align:center;padding-top:50px;"><h1><span style="color:#1DB954">✔</span> Success!</h1><p>Your Spotify is linked to Rust. You can close this window!</p></body>');
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).send('Error linking account.');
    }
});

// ==========================================
// 2. RUST API ENDPOINTS
// ==========================================
const verifyRustServer = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${RUST_SERVER_SECRET}`) {
        return res.status(403).json({ error: 'Unauthorized.' });
    }
    next();
};

async function getValidToken(steamId) {
    const user = db[steamId];
    if (!user) throw new Error('User not linked');

    if (Date.now() > user.expires_at) {
        const response = await axios.post('https://accounts.spotify.com/api/token',
            querystring.stringify({
                grant_type: 'refresh_token',
                refresh_token: user.refresh_token
            }), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + (Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64'))
                }
            }
        );
        user.access_token = response.data.access_token;
        if (response.data.refresh_token) user.refresh_token = response.data.refresh_token; 
        user.expires_at = Date.now() + (response.data.expires_in * 1000);
        saveDb();
    }
    return user.access_token;
}

app.post('/api/spotify/control', verifyRustServer, async (req, res) => {
    const { steamId, action } = req.body;
    try {
        const token = await getValidToken(steamId);
        let url = 'https://api.spotify.com/v1/me/player/';
        let method = 'POST';

        if (action === 'play') { url += 'play'; method = 'PUT'; }
        else if (action === 'pause') { url += 'pause'; method = 'PUT'; }
        else if (action === 'next') { url += 'next'; method = 'POST'; }
        else if (action === 'previous') { url += 'previous'; method = 'POST'; }

        await axios({ method: method, url: url, headers: { 'Authorization': `Bearer ${token}` } });
        res.json({ success: true });
    } catch (error) {
        if (error.response && error.response.status === 404) return res.status(404).json({ error: 'No active device.' });
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));