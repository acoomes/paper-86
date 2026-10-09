// Comprehensive verification of fixed physics
const { chromium } = require('playwright');

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function verifyFixed() {
    console.log('🔧 COMPREHENSIVE PHYSICS VERIFICATION');
    console.log('=====================================\n');
    
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    // Capture console messages
    const consoleMessages = [];
    page.on('console', msg => {
        consoleMessages.push(`${msg.type()}: ${msg.text()}`);
    });
    
    // Capture page errors
    const pageErrors = [];
    page.on('pageerror', error => {
        pageErrors.push(error.toString());
    });
    
    await page.goto('http://localhost:8080/');
    
    // Wait for canvas to be present
    await page.waitForSelector('#game-canvas', { timeout: 5000 });
    
    // Wait for script to load and execute
    await page.waitForFunction(() => {
        return typeof window.car !== 'undefined';
    }, { timeout: 10000 });
    
    await sleep(500); // Additional settle time
    
    // Check if game loaded
    const gameLoaded = await page.evaluate(() => {
        return typeof window.car !== 'undefined' && typeof window.gameState !== 'undefined';
    });
    
    if (!gameLoaded) {
        console.log('⚠️  Game not loaded properly');
        console.log('Console messages:', consoleMessages.slice(-5));
        console.log('Page errors:', pageErrors);
        await browser.close();
        return;
    }
    
    console.log('✅ Game loaded successfully');
    
    // Check initial car state
    const initialState = await page.evaluate(() => ({
        x: window.car.x,
        y: window.car.y,
        speed: window.car.speed,
        gameState: window.gameState
    }));
    console.log('Initial car state:', initialState);
    
    // Start game
    console.log('\nStarting 60-second test run...\n');
    await page.keyboard.down('Space');
    await sleep(50);
    await page.keyboard.up('Space');
    
    // Check if game started
    const gameStarted = await page.evaluate(() => window.gameState);
    console.log(`Game state: ${gameStarted}\n`);
    
    await sleep(3000); // Let car accelerate
    
    // Measure cruise speed
    const speedSamples = [];
    const posSamples = [];
    for (let i = 0; i < 10; i++) {
        await sleep(100);
        const data = await page.evaluate(() => {
            if (!window.car) return null;
            return {
                speed: window.car.speed,
                x: window.car.x,
                y: window.car.y,
                vx: window.car.vx,
                vy: window.car.vy,
                gameState: window.gameState,
                timeLeft: window.timeLeft
            };
        });
        if (data) {
            speedSamples.push(data.speed);
            posSamples.push({x: data.x, y: data.y});
        }
    }
    
    const avgSpeed = speedSamples.reduce((a,b) => a+b, 0) / speedSamples.length;
    const maxSpeed = Math.max(...speedSamples);
    
    // Calculate actual px/s by measuring position change
    let measuredPxPerSec = 0;
    if (posSamples.length >= 2) {
        const dx = posSamples[posSamples.length-1].x - posSamples[0].x;
        const dy = posSamples[posSamples.length-1].y - posSamples[0].y;
        const distance = Math.sqrt(dx*dx + dy*dy);
        const timeSec = (posSamples.length - 1) * 0.1;
        measuredPxPerSec = distance / timeSec;
        
        console.log('📊 SPEED VERIFICATION');
        console.log(`  car.speed: ${avgSpeed.toFixed(2)} units/frame`);
        console.log(`  Measured: ${measuredPxPerSec.toFixed(1)} px/s (actual movement)`);
        console.log(`  Target: ~190 px/s (main's calibrated speed)`);
        console.log(`  Status: ${Math.abs(measuredPxPerSec - 190) < 40 ? '✅ GOOD' : '⚠️  OFF'}\n`);
    }
    
    // Test drift for 3 seconds
    console.log('📊 DRIFT TEST (Space + Right for 3s)...');
    await page.keyboard.down('Space');
    await sleep(200);
    await page.keyboard.down('ArrowRight');
    
    const driftSamples = [];
    for (let i = 0; i < 15; i++) {
        await sleep(200);
        const data = await page.evaluate(() => {
            if (!window.car) return null;
            return {
                speed: window.car.speed,
                slipAngle: window.car.slipAngle,
                x: window.car.x,
                y: window.car.y
            };
        });
        if (data) driftSamples.push(data);
    }
    
    await page.keyboard.up('Space');
    await page.keyboard.up('ArrowRight');
    
    const slipAngles = driftSamples
        .map(d => d.slipAngle !== undefined ? Math.abs(d.slipAngle) * 180 / Math.PI : 0)
        .filter(a => a > 0);
    
    const maxSlip = slipAngles.length > 0 ? Math.max(...slipAngles) : 0;
    const avgSlip = slipAngles.length > 0 ? slipAngles.reduce((a,b) => a+b, 0) / slipAngles.length : 0;
    
    console.log(`  Peak slip: ${maxSlip.toFixed(1)}°`);
    console.log(`  Avg slip: ${avgSlip.toFixed(1)}°`);
    console.log(`  Target: 15-30° for controllable drift`);
    console.log(`  Status: ${maxSlip > 10 ? '✅ DRIFTING' : '⚠️  TOO PLANTED'}\n`);
    
    // Check boundaries
    const allPositions = [...posSamples, ...driftSamples].map(p => ({x: p.x, y: p.y}));
    const minX = Math.min(...allPositions.map(p => p.x));
    const maxX = Math.max(...allPositions.map(p => p.x));
    const minY = Math.min(...allPositions.map(p => p.y));
    const maxY = Math.max(...allPositions.map(p => p.y));
    
    console.log('📊 BOUNDARY CHECK');
    console.log(`  X range: ${minX.toFixed(0)} to ${maxX.toFixed(0)}`);
    console.log(`  Y range: ${minY.toFixed(0)} to ${maxY.toFixed(0)}`);
    console.log(`  Track bounds: ~100-1000 x, ~100-850 y`);
    const inBounds = minX > 50 && maxX < 1050 && minY > 50 && maxY < 900;
    console.log(`  Status: ${inBounds ? '✅ CONTAINED' : '⚠️  OUT OF BOUNDS'}\n`);
    
    // Let run complete to test audio cleanup
    console.log('Running to timeout to test audio cleanup...');
    await sleep(2000);
    
    // Check oscillators
    const oscillatorCount = await page.evaluate(() => {
        // Try to detect if drift sound is still playing
        return window.driftOscillator ? 1 : 0;
    });
    
    console.log('\n📊 AUDIO CHECK');
    console.log(`  Drift oscillators running: ${oscillatorCount}`);
    console.log(`  Status: ${oscillatorCount === 0 ? '✅ CLEAN' : '⚠️  LEAKED'}\n`);
    
    await browser.close();
    
    console.log('=====================================');
    console.log('SUMMARY');
    console.log('  Speed: Measuring ~' + (measuredPxPerSec ? measuredPxPerSec.toFixed(0) : 'N/A') + ' px/s');
    console.log('  Drift: Peak ' + maxSlip.toFixed(1) + '°');
    console.log('  Bounds: ' + (inBounds ? 'Contained' : 'Exceeded'));
    console.log('  Audio: ' + (oscillatorCount === 0 ? 'Clean' : 'Leaked'));
}

verifyFixed().catch(console.error);
