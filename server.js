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

app.use(express.static(path.join(__dirname, 'public')));

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI; 
const RUST_SERVER_SECRET = process.env.RUST_SERVER_SECRET || "lmohs"; 
const PORT = process.env.PORT || 3000;

const DB_FILE = '/tmp/tokens.json'; 
let db = {};
if (fs.existsSync(DB_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) {}
}
const saveDb = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

app.get('/auth/login', (req, res) => {
    const steamId = req.query.steamId;
    if (!steamId) return res.status(400).send('Missing Steam ID');
    // Added 'streaming' scope for the Web Playback SDK
    const scope = 'user-modify-playback-state user-read-playback-state user-read-currently-playing streaming user-read-email user-private';
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
            querystring.stringify({ code: code, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' }), 
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + (Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')) } }
        );
        db[steamId] = {
            access_token: response.data.access_token,
            refresh_token: response.data.refresh_token,
            expires_at: Date.now() + (response.data.expires_in * 1000)
        };
        saveDb();
        res.redirect(`/?token=${response.data.access_token}&linked=true`);
    } catch (error) { res.status(500).send('Link failed.'); }
});

const verify = (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${RUST_SERVER_SECRET}`) return res.status(403).send('Forbidden');
    next();
};

async function getToken(steamId) {
    const user = db[steamId];
    if (!user) throw new Error('Not linked');
    if (Date.now() > user.expires_at) {
        const res = await axios.post('https://accounts.spotify.com/api/token',
            querystring.stringify({ grant_type: 'refresh_token', refresh_token: user.refresh_token }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + (Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')) } }
        );
        user.access_token = res.data.access_token;
        user.expires_at = Date.now() + (res.data.expires_in * 1000);
        saveDb();
    }
    return user.access_token;
}

app.post('/api/spotify/control', verify, async (req, res) => {
    const { steamId, action } = req.body;
    try {
        const token = await getToken(steamId);
        let url = 'https://api.spotify.com/v1/me/player/';
        let method = action === 'play' || action === 'pause' ? 'PUT' : 'POST';
        if (action === 'play') url += 'play';
        else if (action === 'pause') url += 'pause';
        else if (action === 'next') url += 'next';
        else if (action === 'previous') url += 'previous';
        await axios({ method, url, headers: { 'Authorization': `Bearer ${token}` } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/spotify/current', verify, async (req, res) => {
    const { steamId } = req.body;
    try {
        const token = await getToken(steamId);
        const response = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', { headers: { 'Authorization': `Bearer ${token}` } });
        if (response.status === 204 || !response.data) return res.json({ success: true, track_name: "Nothing Playing" });
        const item = response.data.item;
        res.json({ success: true, track_name: item.name, artist_name: item.artists[0].name, image_url: item.album.images[0].url });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT);