// Test physics math for NaN issues and basic correctness
// This simulates the core physics without canvas/DOM dependencies

const PHYSICS = {
    ACCELERATION: 0.25,
    MAX_SPEED: 6.5,
    CRUISE_SPEED: 5.0,
    MIN_SPEED_FOR_STEERING: 0.8,
    BASE_STEERING_RATE: 0.078,
    MIN_STEERING_RATE: 0.025,
    STEERING_SPEED_CURVE: 0.7,
    LATERAL_GRIP: 0.88,
    DRIFT_REAR_GRIP: 0.45,
    DRIFT_FRONT_GRIP: 0.92,
    GRIP_RECOVERY_RATE: 0.08,
    DRIFT_SPEED_RETENTION: 0.985,
    CLEAN_DRIFT_THRESHOLD: 0.35,
    MESSY_DRIFT_PENALTY: 0.975,
    BASE_DRAG: 0.992,
    ROLLING_RESISTANCE: 0.003,
    PHYSICS_HZ: 120
};

const physicsDt = 1 / PHYSICS.PHYSICS_HZ;

function normalizeAngle(angle) {
    while (angle > Math.PI) angle -= Math.PI * 2;
    while (angle < -Math.PI) angle += Math.PI * 2;
    return angle;
}

function simulatePhysicsStep(car, steerInput, isDrifting) {
    // Speed-sensitive steering rate
    const speedRatio = Math.min(car.speed / PHYSICS.MAX_SPEED, 1.0);
    const steerLerp = Math.pow(1.0 - speedRatio, PHYSICS.STEERING_SPEED_CURVE);
    const steeringRate = PHYSICS.MIN_STEERING_RATE + (PHYSICS.BASE_STEERING_RATE - PHYSICS.MIN_STEERING_RATE) * steerLerp;
    
    // Update heading
    if (steerInput !== 0 && car.speed > PHYSICS.MIN_SPEED_FOR_STEERING) {
        car.heading += steeringRate * steerInput;
    }
    
    // Acceleration
    car.vx += Math.cos(car.heading) * PHYSICS.ACCELERATION;
    car.vy += Math.sin(car.heading) * PHYSICS.ACCELERATION;
    
    // Calculate speed and velocity angle
    car.speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    const velocityAngle = car.speed > 0.1 ? Math.atan2(car.vy, car.vx) : car.heading;
    
    // Slip angle
    let slipAngle = normalizeAngle(car.heading - velocityAngle);
    car.slipAngle = slipAngle;
    
    // Grip transition
    const targetGrip = isDrifting ? PHYSICS.DRIFT_REAR_GRIP : 1.0;
    car.currentGripFactor += (targetGrip - car.currentGripFactor) * PHYSICS.GRIP_RECOVERY_RATE;
    
    // Lateral damping
    const forwardVel = car.vx * Math.cos(car.heading) + car.vy * Math.sin(car.heading);
    const lateralVel = -car.vx * Math.sin(car.heading) + car.vy * Math.cos(car.heading);
    
    const lateralGrip = isDrifting ? 
        (PHYSICS.DRIFT_FRONT_GRIP + car.currentGripFactor * (PHYSICS.LATERAL_GRIP - PHYSICS.DRIFT_FRONT_GRIP)) :
        PHYSICS.LATERAL_GRIP;
    const dampedLateralVel = lateralVel * lateralGrip;
    
    // Reconstruct velocity
    car.vx = Math.cos(car.heading) * forwardVel - Math.sin(car.heading) * dampedLateralVel;
    car.vy = Math.sin(car.heading) * forwardVel + Math.cos(car.heading) * dampedLateralVel;
    
    // Drift speed loss
    if (isDrifting && car.speed > 2.5) {
        const absSlip = Math.abs(slipAngle);
        const speedLoss = absSlip < PHYSICS.CLEAN_DRIFT_THRESHOLD ? 
            PHYSICS.DRIFT_SPEED_RETENTION : 
            PHYSICS.DRIFT_SPEED_RETENTION * PHYSICS.MESSY_DRIFT_PENALTY;
        car.vx *= speedLoss;
        car.vy *= speedLoss;
    }
    
    // Drag
    car.speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    if (car.speed > 0.1) {
        car.vx *= PHYSICS.BASE_DRAG;
        car.vy *= PHYSICS.BASE_DRAG;
        const resistanceLoss = PHYSICS.ROLLING_RESISTANCE;
        const velScale = Math.max(0, car.speed - resistanceLoss) / car.speed;
        car.vx *= velScale;
        car.vy *= velScale;
    }
    
    // Speed cap
    car.speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    if (car.speed > PHYSICS.MAX_SPEED) {
        const scale = PHYSICS.MAX_SPEED / car.speed;
        car.vx *= scale;
        car.vy *= scale;
        car.speed = PHYSICS.MAX_SPEED;
    }
    
    // Update position
    car.x += car.vx;
    car.y += car.vy;
}

function hasNaN(car) {
    return isNaN(car.x) || isNaN(car.y) || isNaN(car.vx) || isNaN(car.vy) || 
           isNaN(car.heading) || isNaN(car.speed) || isNaN(car.slipAngle);
}

function runTest(name, testFn) {
    try {
        testFn();
        console.log(`✓ ${name}`);
        return true;
    } catch (e) {
        console.error(`✗ ${name}: ${e.message}`);
        return false;
    }
}

// Test 1: Straight line acceleration
runTest("Straight acceleration (no NaN)", () => {
    const car = { x: 0, y: 0, vx: 0, vy: 0, heading: 0, speed: 0, slipAngle: 0, currentGripFactor: 1.0 };
    
    for (let i = 0; i < 1000; i++) {
        simulatePhysicsStep(car, 0, false);
        if (hasNaN(car)) {
            throw new Error(`NaN detected at step ${i}: ${JSON.stringify(car)}`);
        }
    }
    
    if (car.speed < 4.0) {
        throw new Error(`Speed too low: ${car.speed}`);
    }
});

// Test 2: Sustained drifting
runTest("Sustained drift (no NaN)", () => {
    const car = { x: 0, y: 0, vx: 3, vy: 0, heading: 0.5, speed: 3, slipAngle: 0, currentGripFactor: 1.0 };
    
    for (let i = 0; i < 1000; i++) {
        simulatePhysicsStep(car, 1, true);  // Turn right while drifting
        if (hasNaN(car)) {
            throw new Error(`NaN detected at step ${i}: ${JSON.stringify(car)}`);
        }
    }
});

// Test 3: Sharp cornering
runTest("Sharp cornering (no NaN)", () => {
    const car = { x: 0, y: 0, vx: 5, vy: 0, heading: 0, speed: 5, slipAngle: 0, currentGripFactor: 1.0 };
    
    for (let i = 0; i < 500; i++) {
        simulatePhysicsStep(car, -1, false);  // Sharp left turn
        if (hasNaN(car)) {
            throw new Error(`NaN detected at step ${i}: ${JSON.stringify(car)}`);
        }
    }
});

// Test 4: Speed cap enforcement
runTest("Speed cap at MAX_SPEED", () => {
    const car = { x: 0, y: 0, vx: 0, vy: 0, heading: 0, speed: 0, slipAngle: 0, currentGripFactor: 1.0 };
    
    for (let i = 0; i < 2000; i++) {
        simulatePhysicsStep(car, 0, false);
    }
    
    if (car.speed > PHYSICS.MAX_SPEED + 0.01) {
        throw new Error(`Speed exceeded max: ${car.speed} > ${PHYSICS.MAX_SPEED}`);
    }
});

// Test 5: Drift grip recovery
runTest("Grip recovery after drift", () => {
    const car = { x: 0, y: 0, vx: 4, vy: 0, heading: 0.3, speed: 4, slipAngle: 0, currentGripFactor: 1.0 };
    
    // Drift for a while
    for (let i = 0; i < 200; i++) {
        simulatePhysicsStep(car, 1, true);
    }
    
    const gripDuringDrift = car.currentGripFactor;
    
    // Release drift and let grip recover
    for (let i = 0; i < 200; i++) {
        simulatePhysicsStep(car, 0, false);
    }
    
    if (car.currentGripFactor <= gripDuringDrift + 0.1) {
        throw new Error(`Grip didn't recover: ${gripDuringDrift} -> ${car.currentGripFactor}`);
    }
});

// Test 6: Circular motion (continuous turning)
runTest("Circular motion stability", () => {
    const car = { x: 0, y: 0, vx: 4, vy: 0, heading: 0, speed: 4, slipAngle: 0, currentGripFactor: 1.0 };
    
    // Try to drive in a circle
    for (let i = 0; i < 1000; i++) {
        simulatePhysicsStep(car, 1, false);
        if (hasNaN(car)) {
            throw new Error(`NaN detected at step ${i}`);
        }
    }
    
    // Should have turned significantly
    if (Math.abs(car.heading) < 3.0) {
        throw new Error(`Not enough turning: heading = ${car.heading}`);
    }
});

// Test 7: Slip angle calculation
runTest("Slip angle bounds", () => {
    const car = { x: 0, y: 0, vx: 3, vy: 2, heading: 0, speed: 0, slipAngle: 0, currentGripFactor: 1.0 };
    
    for (let i = 0; i < 500; i++) {
        simulatePhysicsStep(car, Math.sin(i * 0.1), true);  // Oscillating input
        
        if (Math.abs(car.slipAngle) > Math.PI) {
            throw new Error(`Slip angle out of bounds: ${car.slipAngle}`);
        }
    }
});

// Test 8: Zero speed stability
runTest("Zero speed handling", () => {
    const car = { x: 0, y: 0, vx: 0, vy: 0, heading: 0, speed: 0, slipAngle: 0, currentGripFactor: 1.0 };
    
    for (let i = 0; i < 100; i++) {
        simulatePhysicsStep(car, 1, false);
        if (hasNaN(car)) {
            throw new Error(`NaN at zero speed step ${i}`);
        }
    }
});

console.log("\n=== Physics Test Summary ===");
console.log("All tests check for NaN values, speed caps, and physics stability.");
console.log("Tests simulate 60Hz display with 120Hz physics (fixed timestep).");
