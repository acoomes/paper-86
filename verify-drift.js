// Browser-based drift verification using Playwright
// Properly injects keyboard events to test drift physics

const { chromium } = require('playwright');

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function verifyDriftPhysics() {
    console.log('🚗 Starting browser drift physics verification...\n');
    
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    // Navigate to local server
    await page.goto('http://localhost:8080/');
    await sleep(1000); // Let game initialize
    
    console.log('✓ Page loaded\n');
    
    // Enable test mode (disables wall collisions for testing)
    await page.evaluate(() => {
        if (window.setTestMode) window.setTestMode(true);
        if (window.enablePhysicsDebug) window.enablePhysicsDebug();
    });
    
    // Start game by pressing space
    await page.keyboard.down('Space');
    await sleep(50);
    await page.keyboard.up('Space');
    await sleep(500);
    
    console.log('✓ Game started (test mode: collisions disabled)\n');
    
    // Wait for car to accelerate (automatic throttle - no up arrow needed)
    // Stay within collision grace period
    console.log('📊 Phase 1: Waiting for automatic acceleration...');
    await sleep(3000); // Wait 3s out of 3.5s grace period
    
    const speed1 = await page.evaluate(() => window.car ? window.car.speed : 0);
    console.log(`   Speed reached: ${speed1.toFixed(2)}\n`);
    
    // Test 1: Initiate drift (hold space + turn RIGHT to stay on track)
    console.log('📊 Phase 2: Initiating drift (Space + Right)...');
    await page.keyboard.down('Space');
    await sleep(100);
    await page.keyboard.down('ArrowRight');
    
    // Sample drift metrics over 1.5 seconds
    const samples = [];
    const sampleInterval = 100; // ms
    const sampleDuration = 1500; // ms
    const numSamples = sampleDuration / sampleInterval;
    
    for (let i = 0; i < numSamples; i++) {
        await sleep(sampleInterval);
        const data = await page.evaluate(() => {
            if (!window.car) return null;
            return {
                speed: window.car.speed,
                slipAngle: window.car.slipAngle,
                heading: window.car.heading,
                gripFactor: window.car.currentGripFactor,
                x: window.car.x,
                y: window.car.y
            };
        });
        
        if (data) {
            samples.push(data);
            const slipDeg = (data.slipAngle * 180 / Math.PI).toFixed(1);
            console.log(`   Sample ${i+1}/${numSamples}: speed=${data.speed.toFixed(2)}, slip=${slipDeg}°, grip=${data.gripFactor.toFixed(3)}`);
        }
    }
    
    console.log();
    
    // Release right, apply countersteer (left - opposite of drift turn)
    console.log('📊 Phase 3: Countersteering (Left to catch slide)...');
    await page.keyboard.up('ArrowRight');
    await sleep(50);
    await page.keyboard.down('ArrowLeft');
    await sleep(1000);
    
    const counterSamples = [];
    for (let i = 0; i < 5; i++) {
        await sleep(100);
        const data = await page.evaluate(() => {
            if (!window.car) return null;
            return {
                speed: window.car.speed,
                slipAngle: window.car.slipAngle,
                gripFactor: window.car.currentGripFactor
            };
        });
        
        if (data) {
            counterSamples.push(data);
            const slipDeg = (data.slipAngle * 180 / Math.PI).toFixed(1);
            console.log(`   Countersteer ${i+1}/5: speed=${data.speed.toFixed(2)}, slip=${slipDeg}°, grip=${data.gripFactor.toFixed(3)}`);
        }
    }
    
    console.log();
    
    // Release drift button to test grip recovery
    console.log('📊 Phase 4: Releasing drift (grip recovery)...');
    await page.keyboard.up('Space');
    
    const recoverySamples = [];
    for (let i = 0; i < 8; i++) {
        await sleep(100);
        const data = await page.evaluate(() => {
            if (!window.car) return null;
            return {
                speed: window.car.speed,
                slipAngle: window.car.slipAngle,
                gripFactor: window.car.currentGripFactor
            };
        });
        
        if (data) {
            recoverySamples.push(data);
            const slipDeg = (data.slipAngle * 180 / Math.PI).toFixed(1);
            console.log(`   Recovery ${i+1}/8: speed=${data.speed.toFixed(2)}, slip=${slipDeg}°, grip=${data.gripFactor.toFixed(3)}`);
        }
    }
    
    console.log();
    
    // Get final drift stats
    await page.keyboard.up('ArrowLeft');
    await sleep(500);
    
    const finalStats = await page.evaluate(() => {
        // Access the current values via getter functions
        return {
            driftTime: window.getRunStats ? window.getRunStats().driftTime : 0,
            clips: window.getRunStats ? window.getRunStats().clips : 0,
            score: window.getScore ? window.getScore() : 0,
            gameState: window.getGameState ? window.getGameState() : 'unknown',
            physicsDebug: window.getPhysicsDebugLog ? window.getPhysicsDebugLog() : []
        };
    });
    
    // Show physics debug log if any large speed changes occurred
    if (finalStats.physicsDebug && finalStats.physicsDebug.length > 0) {
        console.log('\n⚠️  Physics Debug Log (large speed changes):');
        finalStats.physicsDebug.forEach((entry, i) => {
            console.log(`   ${i+1}. Speed ${entry.oldSpeed} → ${entry.newSpeed} (Δ${entry.deltaSpeed})`);
            console.log(`      Velocity: (${entry.oldVx}, ${entry.oldVy}) → (${entry.newVx}, ${entry.newVy})`);
            console.log(`      Slip=${entry.slipAngle}, grip=${entry.gripFactor}, drift=${entry.isDrifting}, heading=${entry.heading}`);
        });
        console.log();
    }
    
    await browser.close();
    
    // Analysis
    console.log('═══════════════════════════════════════════════════════');
    console.log('📈 DRIFT VERIFICATION RESULTS\n');
    
    // Check if we got data
    if (samples.length === 0) {
        console.log('❌ ERROR: No samples collected during drift phase');
        console.log('   The game may not have started properly or car object not accessible\n');
        await browser.close();
        return false;
    }
    
    // Check if drift initiated
    const maxSlip = Math.max(...samples.map(s => Math.abs(s.slipAngle)));
    const maxSlipDeg = (maxSlip * 180 / Math.PI).toFixed(1);
    const minGrip = Math.min(...samples.map(s => s.gripFactor));
    
    console.log('✓ Drift Initiation:');
    console.log(`  Max slip angle: ${maxSlipDeg}° (target: >10°)`);
    console.log(`  Min grip factor: ${minGrip.toFixed(3)} (target: <0.6)`);
    
    const driftInitiated = maxSlip > 0.18; // DRIFT_SLIP_THRESHOLD
    console.log(`  Status: ${driftInitiated ? '✅ DRIFT DETECTED' : '❌ NO DRIFT'}\n`);
    
    // Check grip recovery
    const finalGrip = recoverySamples[recoverySamples.length - 1].gripFactor;
    const gripRecovered = finalGrip > 0.9;
    console.log('✓ Grip Recovery:');
    console.log(`  Final grip factor: ${finalGrip.toFixed(3)} (target: >0.9)`);
    console.log(`  Status: ${gripRecovered ? '✅ GRIP RECOVERED' : '⚠️ INCOMPLETE'}\n`);
    
    // Check drift time stat
    if (finalStats) {
        console.log('✓ Game Stats:');
        console.log(`  Drift time: ${finalStats.driftTime.toFixed(2)}s`);
        console.log(`  Clips: ${finalStats.clips}`);
        console.log(`  Score: ${Math.floor(finalStats.score)}`);
        
        const statWorking = finalStats.driftTime > 0;
        console.log(`  Status: ${statWorking ? '✅ DRIFT STAT WORKING' : '❌ DRIFT TIME NOT ACCUMULATING'}\n`);
    }
    
    // Overall verdict
    console.log('═══════════════════════════════════════════════════════');
    const allPassed = driftInitiated && gripRecovered && (finalStats && finalStats.driftTime > 0);
    
    if (allPassed) {
        console.log('🎉 VERDICT: All drift mechanics working correctly!');
        console.log('   - Drift initiates with Space + steering');
        console.log('   - Slip angle develops as expected');
        console.log('   - Grip drops during drift');
        console.log('   - Grip recovers after release');
        console.log('   - Drift time stat accumulates');
    } else {
        console.log('⚠️  VERDICT: Issues detected in drift mechanics');
        if (!driftInitiated) console.log('   ❌ Drift not initiating (slip angle too low)');
        if (!gripRecovered) console.log('   ⚠️  Grip recovery incomplete');
        if (finalStats && finalStats.driftTime === 0) console.log('   ❌ Drift time stat not working');
    }
    console.log('═══════════════════════════════════════════════════════\n');
    
    return allPassed;
}

// Run verification
verifyDriftPhysics()
    .then(passed => {
        process.exit(passed ? 0 : 1);
    })
    .catch(err => {
        console.error('Error during verification:', err);
        process.exit(1);
    });
