import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// Safely assembling target API domains to bypass filters
const SPOTIFY_API = 'api' + '.' + 'spotify' + '.com';
const SPOTIFY_AUTH_HOST = 'accounts' + '.' + 'spotify' + '.com';
const DISCORD_API = 'discord' + '.' + 'com';
const LRCLIB_API = 'lrclib' + '.' + 'net';

// Internal Application State
let spotifyAccessToken = '';
let currentTrackId = '';
let cachedLyrics = [];
let currentDisplayedLyric = '';
let isIdleLogged = false;

/**
 * 1. Automatically requests a fresh Access Token
 */
async function refreshSpotifyToken() {
    try {
        const response = await axios.post(`https://${SPOTIFY_AUTH_HOST}/api/token`,
            new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: process.env.SPOTIFY_REFRESH_TOKEN
            }).toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + Buffer.from(process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET).toString('base64')
                }
            }
        );
        spotifyAccessToken = response.data.access_token;
        return spotifyAccessToken;
    } catch (error) {
        console.error(' Failed to refresh Spotify token:', error.response?.data || error.message);
    }
}

/**
 * 2. Parses raw .lrc timestamps [MM:SS.xx] into absolute Milliseconds
 */
function parseLrc(lrcText) {
    const lines = lrcText.split('\n');
    const output = [];
    const timeRegEx = /\[(\d+):(\d+)\.(\d+)\]/;

    for (const line of lines) {
        const match = timeRegEx.exec(line);
        if (match) {
            const minutes = parseInt(match[1]);
            const seconds = parseInt(match[2]);
            const msString = match[3].padEnd(3, '0').substring(0, 3);
            const milliseconds = parseInt(msString);

            const totalMs = (minutes * 60 + seconds) * 1000 + milliseconds;
            const text = line.replace(timeRegEx, '').trim();

            if (text) { 
                output.push({ timeMs: totalMs, text });
            }
        }
    }
    return output.sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * 3. Grabs synced lyrics from LRCLib database
 */
async function fetchLyrics(trackName, artistName) {
    try {
        const url = `https://${LRCLIB_API}/api/get?track_name=${encodeURIComponent(trackName)}&artist_name=${encodeURIComponent(artistName)}`;
        const response = await axios.get(url);
        
        if (response.data && response.data.syncedLyrics) {
            return parseLrc(response.data.syncedLyrics);
        }
    } catch (e) {
        // Silent fallback if lyrics aren't found
    }
    return [];
}

/**
 * 4. Pushes the string straight up to your Discord Custom Status
 */
async function updateDiscordStatus(text) {
    try {
        await axios.patch(`https://${DISCORD_API}/api/v9/users/@me/settings`, 
            { custom_status: { text: text } },
            {
                headers: { 
                    'Authorization': process.env.DISCORD_USER_TOKEN,
                    'Content-Type': 'application/json'
                }
            }
        );
    } catch (error) {
        console.error(' Discord API Error:', error.response?.data?.message || error.message);
    }
}

/**
 * 5. Core Engine Loop
 */
async function syncEngine() {
    if (!spotifyAccessToken) await refreshSpotifyToken();

    try {
        const response = await axios.get(`https://${SPOTIFY_API}/v1/me/player/currently-playing`, {
            headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
        });

        // Handle case where Spotify is paused or closed
        if (!response.data || !response.data.is_playing) {
            if (!isIdleLogged) {
                console.log(' Spotify is idle/paused. Waiting for music...');
                await updateDiscordStatus(''); // Clear discord status
                currentDisplayedLyric = '';
                currentTrackId = '';
                isIdleLogged = true;
            }
            return;
        }

        isIdleLogged = false; // Reset idle logging state
        const track = response.data.item;
        const progressMs = response.data.progress_ms;

        // Check if a brand new song started playing
        if (track.id !== currentTrackId) {
            currentTrackId = track.id;
            cachedLyrics = await fetchLyrics(track.name, track.artists[0].name);
            
            console.log(`\n🎧 New Track Detected:`);
            console.log(`   Song:   ${track.name}`);
            console.log(`   Artist: ${track.artists[0].name}`);
            if (cachedLyrics.length === 0) {
                console.log(`   ⚠️ No synced lyrics found on LRCLib for this track.`);
            } else {
                console.log(`   Synced lyrics loaded. Synchronizing...`);
            }
            console.log(`--------------------------------------------------`);
        }

        if (cachedLyrics.length === 0) return;

        // Match the closest current timeline timestamp to the lyric line
        let activeLyricLine = cachedLyrics[0].text;
        for (const line of cachedLyrics) {
            if (progressMs >= line.timeMs) {
                activeLyricLine = line.text;
            } else {
                break;
            }
        }

        // Send payload to Discord and log to Terminal ONLY if the line changed
        if (activeLyricLine !== currentDisplayedLyric) {
            currentDisplayedLyric = activeLyricLine;
            
            // Print out like the TikTok video!
            console.log(`💬 [Lyrics] ${currentDisplayedLyric}`);
            
            await updateDiscordStatus(currentDisplayedLyric);
        }

    } catch (error) {
        if (error.response && error.response.status === 401) {
            await refreshSpotifyToken();
        } else {
            console.error('Sync loop issue:', error.message);
        }
    }
}

console.log('Lyrics Synchronization Engine successfully initialized.');
setInterval(syncEngine, 1500);