// Paper 86 v2 - 60-second drift racing game
// Canvas and game state
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

// Game state
let gameState = 'ready'; // 'ready', 'playing', 'ended'
let score = 0;
let bestScore = parseInt(localStorage.getItem('paper86-best') || '0');
let timeLeft = 60;
let combo = 0;
let lastConeTime = 0;
let lastClipTime = 0;
let collisionGraceTime = 0.8; // Grace period after start/restart
let firstRun = !localStorage.getItem('paper86-played');
let screenShake = { x: 0, y: 0, intensity: 0 };

// Input state
const keys = {};
let drifting = false;
let touchDrifting = false;
let touchSteerLeft = false;
let touchSteerRight = false;

// Car state
const car = {
    x: 475,
    y: 725,
    vx: 0,
    vy: 0,
    heading: Math.atan2(700 - 750, 350 - 600), // Car's facing direction
    velocityAngle: Math.atan2(700 - 750, 350 - 600), // Direction of movement
    speed: 0,
    slipAngle: 0,
    slipRecoveryTimer: 0,
    width: 20,
    height: 36
};

// Physics constants
const ACCELERATION = 0.3;
const MAX_SPEED = 8;
const FRICTION = 0.97;
const TURN_SPEED = 0.06;
const DRIFT_TURN_SPEED = 0.09;
const DRIFT_FRICTION = 0.94;
const GRIP_FRICTION = 0.88;
const DRIFT_SPEED_BLEED = 0.96; // Speed loss while drifting
const SLIP_RECOVERY_TIME = 0.2; // Time to snap velocity to heading

// Camera
const camera = {
    x: 0,
    y: 0
};

// Tire marks
const tireMarks = [];
const MAX_TIRE_MARKS = 300;

// Particles
const particles = [];

// Ghost recording and playback
let ghostRecording = [];
let ghostPlayback = [];
let recordingTimer = 0;
const GHOST_SAMPLE_RATE = 0.1; // Record every 0.1 seconds

// CLIP popups
const clipPopups = [];

// Track definition - closed circuit with curves
const trackWidth = 200;
const trackPoints = [
    { x: 400, y: 200 },
    { x: 700, y: 250 },
    { x: 900, y: 400 },
    { x: 850, y: 650 },
    { x: 600, y: 750 },
    { x: 350, y: 700 },
    { x: 200, y: 500 },
    { x: 250, y: 300 }
];

// Generate cones at strategic threading points
const cones = [
    { x: 520, y: 230, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
    { x: 750, y: 270, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
    { x: 870, y: 480, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
    { x: 780, y: 620, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
    { x: 560, y: 740, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
    { x: 320, y: 670, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
    { x: 220, y: 450, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
    { x: 270, y: 320, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
    { x: 330, y: 240, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 }
];

// Initialize
function init() {
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    // Load ghost from localStorage
    const savedGhost = localStorage.getItem('paper86-ghost');
    if (savedGhost) {
        try {
            ghostPlayback = JSON.parse(savedGhost);
        } catch (e) {
            ghostPlayback = [];
        }
    }
    
    // Keyboard controls
    window.addEventListener('keydown', (e) => {
        keys[e.key.toLowerCase()] = true;
        
        if (e.key.toLowerCase() === ' ') {
            e.preventDefault();
            if (gameState === 'ready') {
                startGame();
            } else if (gameState === 'playing') {
                drifting = true;
            }
        }
        
        if (e.key.toLowerCase() === 'r' && gameState === 'ended') {
            restart();
        }
    });
    
    window.addEventListener('keyup', (e) => {
        keys[e.key.toLowerCase()] = false;
        if (e.key.toLowerCase() === ' ') {
            drifting = false;
        }
    });
    
    // Touch/mouse controls for drift and start
    canvas.addEventListener('pointerdown', (e) => {
        if (gameState === 'ready') {
            startGame();
        } else if (gameState === 'ended') {
            restart();
        } else if (gameState === 'playing') {
            touchDrifting = true;
        }
    });
    
    canvas.addEventListener('pointerup', () => {
        touchDrifting = false;
    });
    
    // End screen tap to restart
    const endScreen = document.getElementById('end-screen');
    endScreen.addEventListener('pointerdown', () => {
        if (gameState === 'ended') {
            restart();
        }
    });
    
    // Mobile drift button
    const driftButton = document.getElementById('drift-button');
    driftButton.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (gameState === 'ready') {
            startGame();
        } else if (gameState === 'playing') {
            touchDrifting = true;
        }
    });
    driftButton.addEventListener('pointerup', (e) => {
        e.preventDefault();
        touchDrifting = false;
    });
    driftButton.addEventListener('pointercancel', (e) => {
        e.preventDefault();
        touchDrifting = false;
    });
    
    // Mobile steer buttons
    const leftButton = document.getElementById('left-button');
    leftButton.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        touchSteerLeft = true;
    });
    leftButton.addEventListener('pointerup', (e) => {
        e.preventDefault();
        touchSteerLeft = false;
    });
    leftButton.addEventListener('pointercancel', (e) => {
        e.preventDefault();
        touchSteerLeft = false;
    });
    
    const rightButton = document.getElementById('right-button');
    rightButton.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        touchSteerRight = true;
    });
    rightButton.addEventListener('pointerup', (e) => {
        e.preventDefault();
        touchSteerRight = false;
    });
    rightButton.addEventListener('pointercancel', (e) => {
        e.preventDefault();
        touchSteerRight = false;
    });
    
    // Show mobile controls on touch devices
    if ('ontouchstart' in window) {
        document.getElementById('mobile-controls').classList.remove('hidden');
    }
    
    gameLoop();
}

function resizeCanvas() {
    const container = document.getElementById('game-container');
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
}

function startGame() {
    gameState = 'playing';
    localStorage.setItem('paper86-played', 'true');
    firstRun = false;
    document.getElementById('start-card').classList.add('hidden');
}

function restart() {
    gameState = 'playing';
    score = 0;
    timeLeft = 60;
    combo = 0;
    collisionGraceTime = 0.8;
    car.x = 475;
    car.y = 725;
    car.vx = 0;
    car.vy = 0;
    car.heading = Math.atan2(700 - 750, 350 - 600);
    car.velocityAngle = car.heading;
    car.speed = 0;
    car.slipAngle = 0;
    car.slipRecoveryTimer = 0;
    tireMarks.length = 0;
    particles.length = 0;
    clipPopups.length = 0;
    ghostRecording = [];
    recordingTimer = 0;
    screenShake = { x: 0, y: 0, intensity: 0 };
    cones.forEach(cone => {
        cone.hit = false;
        cone.respawnTimer = 0;
        cone.clipped = false;
        cone.clipResetTimer = 0;
    });
    document.getElementById('end-screen').classList.add('hidden');
    lastConeTime = Date.now();
    lastClipTime = Date.now();
}

function updateCar(dt) {
    if (gameState !== 'playing') return;
    
    const isDrifting = drifting || touchDrifting;
    
    // Steering input
    let steerInput = 0;
    if (keys['arrowleft'] || keys['a'] || touchSteerLeft) steerInput -= 1;
    if (keys['arrowright'] || keys['d'] || touchSteerRight) steerInput += 1;
    
    // Update heading (car's facing direction) based on steering
    if (steerInput !== 0 && car.speed > 0.5) {
        const turnSpeed = isDrifting ? DRIFT_TURN_SPEED : TURN_SPEED;
        const turnAmount = turnSpeed * steerInput * (car.speed / MAX_SPEED);
        car.heading += turnAmount;
    }
    
    // Acceleration (always accelerating forward along heading)
    const accel = ACCELERATION;
    car.vx += Math.cos(car.heading) * accel;
    car.vy += Math.sin(car.heading) * accel;
    
    // Calculate speed and velocity angle
    car.speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    if (car.speed > 0.1) {
        car.velocityAngle = Math.atan2(car.vy, car.vx);
    }
    
    // Calculate slip angle (difference between heading and velocity)
    let slipAngle = car.heading - car.velocityAngle;
    // Normalize to -PI to PI
    while (slipAngle > Math.PI) slipAngle -= Math.PI * 2;
    while (slipAngle < -Math.PI) slipAngle += Math.PI * 2;
    car.slipAngle = slipAngle;
    
    // Apply friction and drift mechanics
    if (isDrifting && car.speed > 2) {
        // Drifting: rear slips out, speed bleeds
        car.vx *= DRIFT_FRICTION * DRIFT_SPEED_BLEED;
        car.vy *= DRIFT_FRICTION * DRIFT_SPEED_BLEED;
        
        // Counter-steering helps recover
        if (Math.sign(steerInput) !== Math.sign(slipAngle) && steerInput !== 0) {
            // Counter-steering: help align velocity toward heading
            const recoveryFactor = 0.15;
            const targetVx = Math.cos(car.heading) * car.speed;
            const targetVy = Math.sin(car.heading) * car.speed;
            car.vx += (targetVx - car.vx) * recoveryFactor;
            car.vy += (targetVy - car.vy) * recoveryFactor;
        }
        
        // Add tire marks when slip is meaningful
        if (Math.abs(slipAngle) > 0.15 && tireMarks.length < MAX_TIRE_MARKS && Math.random() > 0.3) {
            const offsetDist = 10;
            tireMarks.push({
                x: car.x - Math.sin(car.heading) * offsetDist,
                y: car.y + Math.cos(car.heading) * offsetDist,
                angle: car.velocityAngle + (Math.random() - 0.5) * 0.3,
                alpha: 0.8
            });
        }
        
        car.slipRecoveryTimer = 0;
    } else {
        // Not drifting: snap velocity toward heading
        car.vx *= FRICTION;
        car.vy *= FRICTION;
        
        if (Math.abs(slipAngle) > 0.05) {
            // Gradually snap velocity to heading
            car.slipRecoveryTimer += dt;
            const recoveryProgress = Math.min(car.slipRecoveryTimer / SLIP_RECOVERY_TIME, 1);
            const snapFactor = recoveryProgress * 0.3;
            
            const targetVx = Math.cos(car.heading) * car.speed;
            const targetVy = Math.sin(car.heading) * car.speed;
            car.vx += (targetVx - car.vx) * snapFactor;
            car.vy += (targetVy - car.vy) * snapFactor;
        } else {
            car.slipRecoveryTimer = 0;
        }
    }
    
    // Limit max speed
    car.speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    if (car.speed > MAX_SPEED) {
        const scale = MAX_SPEED / car.speed;
        car.vx *= scale;
        car.vy *= scale;
        car.speed = MAX_SPEED;
    }
    
    // Update position
    car.x += car.vx;
    car.y += car.vy;
    
    // Record ghost data
    recordingTimer += dt;
    if (recordingTimer >= GHOST_SAMPLE_RATE) {
        ghostRecording.push({
            x: car.x,
            y: car.y,
            heading: car.heading,
            time: 60 - timeLeft
        });
        recordingTimer = 0;
    }
    
    // Check collisions
    checkCollisions();
    
    // Check cone collection and near-misses
    checkCones();
    
    // Fade tire marks
    tireMarks.forEach(mark => {
        mark.alpha *= 0.995;
    });
    tireMarks.splice(0, tireMarks.filter(m => m.alpha < 0.1).length);
    
    // Update particles
    updateParticles(dt);
    
    // Update CLIP popups
    updateClipPopups(dt);
    
    // Update screen shake
    if (screenShake.intensity > 0) {
        screenShake.intensity *= 0.85;
        if (screenShake.intensity < 0.1) {
            screenShake.intensity = 0;
            screenShake.x = 0;
            screenShake.y = 0;
        } else {
            screenShake.x = (Math.random() - 0.5) * screenShake.intensity;
            screenShake.y = (Math.random() - 0.5) * screenShake.intensity;
        }
    }
}

function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.2; // Gravity
        p.vx *= 0.98;
        p.life -= dt;
        p.alpha = p.life / p.maxLife;
        
        if (p.life <= 0) {
            particles.splice(i, 1);
        }
    }
}

function updateClipPopups(dt) {
    for (let i = clipPopups.length - 1; i >= 0; i--) {
        const popup = clipPopups[i];
        popup.life -= dt;
        popup.y -= 40 * dt; // Float upward
        popup.alpha = Math.min(1, popup.life / 0.3);
        
        if (popup.life <= 0) {
            clipPopups.splice(i, 1);
        }
    }
}

function spawnParticles(x, y, count, color) {
    for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 3;
        particles.push({
            x,
            y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed - 2,
            color,
            life: 0.5 + Math.random() * 0.5,
            maxLife: 1,
            alpha: 1,
            size: 3 + Math.random() * 3
        });
    }
}

function addClipPopup(x, y, comboCount) {
    clipPopups.push({
        x,
        y,
        text: comboCount > 1 ? `x${comboCount}` : 'CLIP',
        life: 1.2,
        alpha: 1
    });
}

function checkCollisions() {
    // Check if car is on track (only after grace period)
    if (collisionGraceTime <= 0 && !isOnTrack(car.x, car.y)) {
        screenShake.intensity = 15;
        endGame('crash');
    }
}

function isOnTrack(x, y) {
    // Find closest point on track centerline
    let minDist = Infinity;
    
    for (let i = 0; i < trackPoints.length; i++) {
        const p1 = trackPoints[i];
        const p2 = trackPoints[(i + 1) % trackPoints.length];
        
        const dist = distanceToSegment(x, y, p1.x, p1.y, p2.x, p2.y);
        minDist = Math.min(minDist, dist);
    }
    
    return minDist < trackWidth / 2;
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    
    if (len2 === 0) return Math.hypot(px - x1, py - y1);
    
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    
    const nearestX = x1 + t * dx;
    const nearestY = y1 + t * dy;
    
    return Math.hypot(px - nearestX, py - nearestY);
}

function checkCones() {
    const now = Date.now();
    const coneRadius = 15;
    const nearMissRadius = 45; // Larger radius for near-miss CLIP detection
    const comboWindow = 3000; // 3 seconds to maintain combo
    const respawnTime = 2000; // 2 seconds to respawn
    const isDrifting = drifting || touchDrifting;
    
    cones.forEach((cone, idx) => {
        if (cone.hit) {
            // Respawn timer
            if (!cone.respawnTimer) {
                cone.respawnTimer = now;
            } else if (now - cone.respawnTimer > respawnTime) {
                cone.hit = false;
                cone.respawnTimer = 0;
                cone.clipped = false;
                cone.clipResetTimer = 0;
            }
            return;
        }
        
        const dist = Math.hypot(car.x - cone.x, car.y - cone.y);
        
        // Check for cone collection (direct hit)
        if (dist < coneRadius + car.width / 2) {
            cone.hit = true;
            combo++;
            score += 100 * combo;
            lastConeTime = now;
            spawnParticles(cone.x, cone.y, 8, '#d4773d');
            addClipPopup(cone.x, cone.y, combo);
        }
        // Check for near-miss CLIP (threading while drifting)
        else if (!cone.clipped && isDrifting && Math.abs(car.slipAngle) > 0.2 && car.speed > 3 && dist < nearMissRadius) {
            cone.clipped = true;
            cone.clipResetTimer = now;
            combo++;
            const clipScore = 50 * combo;
            score += clipScore;
            lastConeTime = now;
            lastClipTime = now;
            spawnParticles(cone.x, cone.y, 5, '#f3e6c9');
            addClipPopup(cone.x, cone.y, combo);
        }
        
        // Reset clipped status after a short time
        if (cone.clipped && cone.clipResetTimer && now - cone.clipResetTimer > 1000) {
            cone.clipped = false;
            cone.clipResetTimer = 0;
        }
    });
    
    // Check if combo should be dropped
    if (combo > 0 && now - lastConeTime > comboWindow) {
        combo = 0;
    }
}

function endGame(reason = 'timeout') {
    gameState = 'ended';
    
    const finalScore = Math.floor(score);
    const isNewBest = finalScore > bestScore;
    
    if (isNewBest) {
        bestScore = finalScore;
        localStorage.setItem('paper86-best', bestScore.toString());
        
        // Save ghost recording
        if (ghostRecording.length > 0) {
            localStorage.setItem('paper86-ghost', JSON.stringify(ghostRecording));
            ghostPlayback = [...ghostRecording];
        }
    }
    
    // Update end card title based on reason
    const endTitle = document.querySelector('.end-title');
    endTitle.textContent = reason === 'crash' ? 'CRASH' : "TIME'S UP";
    
    document.getElementById('final-score').textContent = finalScore;
    document.getElementById('best-score').textContent = bestScore;
    
    // Show new best badge
    const newBestBadge = document.getElementById('new-best-badge');
    if (isNewBest && finalScore > 0) {
        newBestBadge.classList.remove('hidden');
    } else {
        newBestBadge.classList.add('hidden');
    }
    
    document.getElementById('end-screen').classList.remove('hidden');
}

function updateCamera() {
    // Smooth camera follow
    const targetX = car.x - canvas.width / 2;
    const targetY = car.y - canvas.height / 2;
    
    camera.x += (targetX - camera.x) * 0.1;
    camera.y += (targetY - camera.y) * 0.1;
}

function render() {
    // Clear with paper background
    ctx.fillStyle = '#f3e6c9';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Subtle paper texture (very light noise)
    if (Math.random() > 0.97) {
        ctx.fillStyle = 'rgba(92, 83, 72, 0.015)';
        const x = Math.random() * canvas.width;
        const y = Math.random() * canvas.height;
        ctx.fillRect(x, y, 2, 2);
    }
    
    // Apply camera transform with screen shake
    ctx.save();
    ctx.translate(-camera.x + screenShake.x, -camera.y + screenShake.y);
    
    // Draw track
    drawTrack();
    
    // Draw ghost trail (if playing and ghost exists)
    if (gameState === 'playing' && ghostPlayback.length > 0) {
        drawGhost();
    }
    
    // Draw tire marks
    ctx.strokeStyle = 'rgba(42, 36, 28, 0.3)';
    ctx.lineWidth = 3;
    tireMarks.forEach(mark => {
        ctx.globalAlpha = mark.alpha;
        ctx.save();
        ctx.translate(mark.x, mark.y);
        ctx.rotate(mark.angle);
        ctx.beginPath();
        ctx.moveTo(-5, 0);
        ctx.lineTo(5, 0);
        ctx.stroke();
        ctx.restore();
    });
    ctx.globalAlpha = 1;
    
    // Draw cones
    cones.forEach(cone => {
        if (!cone.hit) {
            ctx.fillStyle = '#d4773d';
            ctx.strokeStyle = '#2a241c';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(cone.x, cone.y, 12, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    });
    
    // Draw particles
    particles.forEach(p => {
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    });
    ctx.globalAlpha = 1;
    
    // Draw CLIP popups
    clipPopups.forEach(popup => {
        ctx.globalAlpha = popup.alpha;
        ctx.fillStyle = '#8b1e1e';
        ctx.font = 'bold 16px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(popup.text, popup.x, popup.y);
    });
    ctx.globalAlpha = 1;
    
    // Draw car
    drawCar();
    
    // Draw start card
    if (gameState === 'ready') {
        drawStartCard();
    }
    
    ctx.restore();
}

function drawGhost() {
    if (ghostPlayback.length < 2) return;
    
    const currentTime = 60 - timeLeft;
    
    // Find the closest ghost point
    let ghostPoint = null;
    for (let i = 0; i < ghostPlayback.length; i++) {
        if (ghostPlayback[i].time >= currentTime) {
            ghostPoint = ghostPlayback[i];
            break;
        }
    }
    
    if (!ghostPoint && ghostPlayback.length > 0) {
        ghostPoint = ghostPlayback[ghostPlayback.length - 1];
    }
    
    if (!ghostPoint) return;
    
    // Draw ghost trail (dashed line from recent positions)
    ctx.strokeStyle = 'rgba(139, 30, 30, 0.2)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 8]);
    ctx.beginPath();
    
    let drawnPoints = 0;
    for (let i = 0; i < ghostPlayback.length && drawnPoints < 30; i++) {
        const point = ghostPlayback[i];
        if (point.time <= currentTime) {
            if (drawnPoints === 0) {
                ctx.moveTo(point.x, point.y);
            } else {
                ctx.lineTo(point.x, point.y);
            }
            drawnPoints++;
        }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Draw ghost car
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.translate(ghostPoint.x, ghostPoint.y);
    ctx.rotate(ghostPoint.heading);
    
    ctx.fillStyle = '#8b1e1e';
    ctx.strokeStyle = '#8b1e1e';
    ctx.lineWidth = 1;
    
    ctx.beginPath();
    ctx.moveTo(-8, -14);
    ctx.lineTo(-8, 8);
    ctx.lineTo(-5, 14);
    ctx.lineTo(5, 14);
    ctx.lineTo(8, 8);
    ctx.lineTo(8, -14);
    ctx.closePath();
    ctx.fill();
    
    ctx.restore();
}

function drawStartCard() {
    // Draw translucent overlay
    ctx.save();
    ctx.resetTransform();
    ctx.fillStyle = 'rgba(243, 230, 201, 0.95)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Center card
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    
    // Wordmark
    ctx.fillStyle = '#2a241c';
    ctx.font = '48px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = '0.15em';
    ctx.fillText('PAPER 86', centerX, centerY - 100);
    
    // Pitch
    ctx.font = '16px Georgia, serif';
    ctx.fillStyle = '#5c5348';
    ctx.fillText('60-second drift score attack', centerX, centerY - 50);
    
    // Controls box
    ctx.strokeStyle = '#8b1e1e';
    ctx.lineWidth = 2;
    ctx.strokeRect(centerX - 150, centerY - 10, 300, 80);
    
    ctx.font = 'bold 14px "Courier New", monospace';
    ctx.fillStyle = '#2a241c';
    ctx.fillText('STEER: ARROWS / A+D', centerX, centerY + 10);
    ctx.fillText('DRIFT: HOLD SPACE', centerX, centerY + 35);
    
    // Best score
    if (bestScore > 0) {
        ctx.font = '18px "Courier New", monospace';
        ctx.fillStyle = '#8b1e1e';
        ctx.fillText(`BEST: ${bestScore}`, centerX, centerY + 100);
    }
    
    // Start hint
    ctx.font = 'italic 14px Georgia, serif';
    ctx.fillStyle = '#5c5348';
    ctx.fillText('Press Space or tap to start', centerX, centerY + 140);
    
    ctx.restore();
}

function drawTrack() {
    // Draw track surface
    ctx.strokeStyle = '#2a241c';
    ctx.lineWidth = trackWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    ctx.beginPath();
    ctx.moveTo(trackPoints[0].x, trackPoints[0].y);
    for (let i = 1; i < trackPoints.length; i++) {
        ctx.lineTo(trackPoints[i].x, trackPoints[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    
    // Draw track fill
    ctx.strokeStyle = '#ded4b8';
    ctx.lineWidth = trackWidth - 8;
    
    ctx.beginPath();
    ctx.moveTo(trackPoints[0].x, trackPoints[0].y);
    for (let i = 1; i < trackPoints.length; i++) {
        ctx.lineTo(trackPoints[i].x, trackPoints[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    
    // Draw center line
    ctx.strokeStyle = 'rgba(42, 36, 28, 0.2)';
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 10]);
    
    ctx.beginPath();
    ctx.moveTo(trackPoints[0].x, trackPoints[0].y);
    for (let i = 1; i < trackPoints.length; i++) {
        ctx.lineTo(trackPoints[i].x, trackPoints[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
}

function drawCar() {
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.heading);
    
    // Car body - simple 86 coupe silhouette
    ctx.fillStyle = '#2a241c';
    ctx.strokeStyle = '#2a241c';
    ctx.lineWidth = 2;
    
    // Main body
    ctx.beginPath();
    ctx.moveTo(-10, -18);
    ctx.lineTo(-10, 10);
    ctx.lineTo(-7, 18);
    ctx.lineTo(7, 18);
    ctx.lineTo(10, 10);
    ctx.lineTo(10, -18);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Windshield
    ctx.fillStyle = '#5c5348';
    ctx.beginPath();
    ctx.moveTo(-7, -10);
    ctx.lineTo(-7, -2);
    ctx.lineTo(7, -2);
    ctx.lineTo(7, -10);
    ctx.closePath();
    ctx.fill();
    
    // Hood detail
    ctx.strokeStyle = '#2a241c';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -18);
    ctx.lineTo(0, -10);
    ctx.stroke();
    
    ctx.restore();
}

function updateHUD() {
    if (gameState === 'ready') {
        document.getElementById('time-display').textContent = '60.0';
        document.getElementById('score-display').textContent = '0';
        document.getElementById('combo-display').textContent = '';
    } else {
        document.getElementById('time-display').textContent = timeLeft.toFixed(1);
        document.getElementById('score-display').textContent = Math.floor(score);
        document.getElementById('combo-display').textContent = combo > 0 ? `x${combo}` : '';
    }
}

function gameLoop() {
    const dt = 1 / 60;
    
    if (gameState === 'playing') {
        // Update timer
        timeLeft -= dt;
        if (timeLeft <= 0) {
            timeLeft = 0;
            endGame('timeout');
        }
        
        // Update collision grace
        if (collisionGraceTime > 0) {
            collisionGraceTime -= dt;
        }
        
        updateCar(dt);
        updateCamera();
    }
    
    render();
    updateHUD();
    
    requestAnimationFrame(gameLoop);
}

// Start the game
init();
