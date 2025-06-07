/**
 * Discounting AI - Frame Capture SDK
 * Drop-in solution for any website to enable intelligent discounting
 * 
 * Usage:
 * <script src="discounting-ai.js"></script>
 * <script>
 *   DiscountingAI.init({
 *     apiKey: 'your-api-key',
 *     endpoint: 'https://api.discounting-ai.com/frames',
 *     fps: 5
 *   });
 * </script>
 */

(function(window) {
    'use strict';

    // Main SDK Class
    class DiscountingAI {
        constructor() {
            this.config = {
                fps: 5,                    // Frames per second
                quality: 0.6,              // JPEG quality (0.1-1.0)
                maxWidth: 1280,            // Max frame width
                maxHeight: 720,            // Max frame height
                endpoint: null,            // Backend API endpoint
                apiKey: null,              // API authentication
                debug: false,              // Debug logging
                autoStart: true,           // Start capturing immediately
                bufferSize: 100,           // Local frame buffer size
                batchSize: 10,             // Frames per batch upload
                retryAttempts: 3,          // Network retry attempts
                sessionTimeout: 1800000,   // 30 minutes session timeout
                enableCompression: true,   // Enable frame compression
                trackUserEvents: true,     // Track mouse/click events
                respectDoNotTrack: true    // Respect DNT header
            };

            this.state = {
                isCapturing: false,
                sessionId: null,
                frameCount: 0,
                startTime: null,
                lastFrameTime: 0,
                frameBuffer: [],
                eventBuffer: [],
                uploadQueue: [],
                retryQueue: [],
                networkOnline: navigator.onLine
            };

            this.canvas = null;
            this.ctx = null;
            this.captureInterval = null;
            this.uploadInterval = null;
            this.heartbeatInterval = null;

            this.init = this.init.bind(this);
            this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
            this.handleBeforeUnload = this.handleBeforeUnload.bind(this);
            this.handleNetworkChange = this.handleNetworkChange.bind(this);
        }

        /**
         * Initialize the SDK
         * @param {Object} options Configuration options
         */
        init(options = {}) {
            // Check if already initialized
            if (this.state.sessionId) {
                this.log('SDK already initialized');
                return;
            }

            // Merge configuration
            this.config = { ...this.config, ...options };

            // Respect Do Not Track
            if (this.config.respectDoNotTrack && navigator.doNotTrack === '1') {
                this.log('Do Not Track detected, SDK disabled');
                return;
            }

            // Validate required config
            if (!this.config.endpoint || !this.config.apiKey) {
                console.error('DiscountingAI: endpoint and apiKey are required');
                return;
            }

            // Generate session ID
            this.state.sessionId = this.generateSessionId();
            this.state.startTime = Date.now();

            this.log('Initializing DiscountingAI SDK', {
                sessionId: this.state.sessionId,
                config: this.config
            });

            // Setup capture canvas
            this.setupCanvas();

            // Setup event listeners
            this.setupEventListeners();

            // Start capturing if autoStart enabled
            if (this.config.autoStart) {
                this.startCapture();
            }

            // Send initialization event
            this.sendEvent('sdk_initialized', {
                userAgent: navigator.userAgent,
                viewport: {
                    width: window.innerWidth,
                    height: window.innerHeight
                },
                url: window.location.href,
                referrer: document.referrer
            });

            this.log('SDK initialized successfully');
        }

        /**
         * Setup HTML5 Canvas for frame capture
         */
        setupCanvas() {
            this.canvas = document.createElement('canvas');
            this.ctx = this.canvas.getContext('2d');
            
            // Set canvas dimensions
            const [width, height] = this.config.maxWidth.toString().includes('x') 
                ? this.config.maxWidth.split('x').map(Number)
                : [this.config.maxWidth, this.config.maxHeight];
            
            this.canvas.width = width;
            this.canvas.height = height;

            this.log('Canvas setup complete', { width, height });
        }

        /**
         * Setup event listeners
         */
        setupEventListeners() {
            // Page visibility changes
            document.addEventListener('visibilitychange', this.handleVisibilityChange);

            // Page unload
            window.addEventListener('beforeunload', this.handleBeforeUnload);

            // Network status
            window.addEventListener('online', this.handleNetworkChange);
            window.addEventListener('offline', this.handleNetworkChange);

            // Track user events if enabled
            if (this.config.trackUserEvents) {
                this.setupUserEventTracking();
            }
        }

        /**
         * Setup user interaction tracking
         */
        setupUserEventTracking() {
            // Mouse movements (throttled)
            let mouseThrottle = false;
            document.addEventListener('mousemove', (e) => {
                if (!mouseThrottle) {
                    this.trackEvent('mouse_move', {
                        x: e.clientX,
                        y: e.clientY,
                        timestamp: Date.now()
                    });
                    mouseThrottle = true;
                    setTimeout(() => mouseThrottle = false, 100); // 10fps max
                }
            });

            // Clicks
            document.addEventListener('click', (e) => {
                this.trackEvent('click', {
                    x: e.clientX,
                    y: e.clientY,
                    target: this.getElementSelector(e.target),
                    timestamp: Date.now()
                });
            });

            // Scrolls (throttled)
            let scrollThrottle = false;
            window.addEventListener('scroll', () => {
                if (!scrollThrottle) {
                    this.trackEvent('scroll', {
                        x: window.scrollX,
                        y: window.scrollY,
                        timestamp: Date.now()
                    });
                    scrollThrottle = true;
                    setTimeout(() => scrollThrottle = false, 200); // 5fps max
                }
            });

            // Form interactions
            document.addEventListener('input', (e) => {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                    this.trackEvent('form_input', {
                        field: this.getElementSelector(e.target),
                        type: e.target.type,
                        timestamp: Date.now()
                    });
                }
            });
        }

        /**
         * Start frame capture
         */
        startCapture() {
            if (this.state.isCapturing) {
                this.log('Capture already running');
                return;
            }

            this.state.isCapturing = true;
            const intervalMs = 1000 / this.config.fps;

            this.log('Starting frame capture', { fps: this.config.fps, interval: intervalMs });

            // Start capture loop
            this.captureInterval = setInterval(() => {
                this.captureFrame();
            }, intervalMs);

            // Start upload loop (every 2 seconds)
            this.uploadInterval = setInterval(() => {
                this.processBatchUpload();
            }, 2000);

            // Start heartbeat (every 30 seconds)
            this.heartbeatInterval = setInterval(() => {
                this.sendHeartbeat();
            }, 30000);

            this.sendEvent('capture_started');
        }

        /**
         * Stop frame capture
         */
        stopCapture() {
            if (!this.state.isCapturing) {
                return;
            }

            this.log('Stopping frame capture');

            this.state.isCapturing = false;

            // Clear intervals
            if (this.captureInterval) {
                clearInterval(this.captureInterval);
                this.captureInterval = null;
            }

            if (this.uploadInterval) {
                clearInterval(this.uploadInterval);
                this.uploadInterval = null;
            }

            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }

            // Upload remaining frames
            this.processBatchUpload(true);

            this.sendEvent('capture_stopped');
        }

        /**
         * Capture single frame
         */
        async captureFrame() {
            try {
                const now = Date.now();
                
                // Skip if too frequent (safety check)
                if (now - this.state.lastFrameTime < (1000 / this.config.fps) - 10) {
                    return;
                }

                this.state.lastFrameTime = now;
                this.state.frameCount++;

                // Capture viewport using html2canvas-like approach
                const frameData = await this.captureViewport();

                if (!frameData) {
                    return;
                }

                // Create frame object
                const frame = {
                    sessionId: this.state.sessionId,
                    frameId: this.state.frameCount,
                    timestamp: now,
                    data: frameData,
                    viewport: {
                        width: window.innerWidth,
                        height: window.innerHeight,
                        scrollX: window.scrollX,
                        scrollY: window.scrollY
                    },
                    url: window.location.href,
                    events: this.flushEventBuffer()
                };

                // Add to buffer
                this.state.frameBuffer.push(frame);

                // Maintain buffer size
                if (this.state.frameBuffer.length > this.config.bufferSize) {
                    this.state.frameBuffer.shift();
                }

                this.log(`Frame ${this.state.frameCount} captured`, { size: frameData.length });

            } catch (error) {
                this.log('Frame capture error', error);
            }
        }

        /**
         * Capture viewport using various methods
         */
        async captureViewport() {
            try {
                // Method 1: Try using getDisplayMedia (requires user permission)
                if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
                    return await this.captureWithDisplayMedia();
                }

                // Method 2: DOM to Canvas rendering (fallback)
                return await this.captureWithDOMRendering();

            } catch (error) {
                this.log('Viewport capture failed', error);
                return null;
            }
        }

        /**
         * Capture using Screen Capture API
         */
        async captureWithDisplayMedia() {
            // Note: This requires user permission and may not work in all contexts
            // This is more for demo purposes - production would use DOM rendering
            
            if (!this.stream) {
                this.stream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                        width: this.config.maxWidth,
                        height: this.config.maxHeight
                    }
                });
            }

            const video = document.createElement('video');
            video.srcObject = this.stream;
            video.play();

            return new Promise((resolve) => {
                video.onloadedmetadata = () => {
                    this.ctx.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
                    const dataURL = this.canvas.toDataURL('image/jpeg', this.config.quality);
                    resolve(dataURL);
                };
            });
        }

        /**
         * Capture using DOM rendering (main method)
         */
        async captureWithDOMRendering() {
            // This is a simplified DOM capture - in production you'd use html2canvas
            // or a similar library for accurate rendering
            
            const dataURL = await this.renderDOMToCanvas();
            return dataURL;
        }

        /**
         * Render DOM to canvas (simplified)
         */
        async renderDOMToCanvas() {
            // Clear canvas
            this.ctx.fillStyle = '#ffffff';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

            // Get viewport dimensions
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            
            // Scale factor
            const scaleX = this.canvas.width / viewportWidth;
            const scaleY = this.canvas.height / viewportHeight;

            this.ctx.save();
            this.ctx.scale(scaleX, scaleY);

            // Render visible elements (simplified approach)
            await this.renderVisibleElements();

            this.ctx.restore();

            return this.canvas.toDataURL('image/jpeg', this.config.quality);
        }

        /**
         * Render visible elements to canvas
         */
        async renderVisibleElements() {
            // This is a highly simplified version
            // Production would need comprehensive DOM traversal and rendering
            
            const elements = document.querySelectorAll('*');
            
            for (let element of elements) {
                const rect = element.getBoundingClientRect();
                
                // Skip if not visible
                if (rect.width === 0 || rect.height === 0) continue;
                if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
                if (rect.right < 0 || rect.left > window.innerWidth) continue;

                // Render element (very simplified)
                this.renderElement(element, rect);
            }
        }

        /**
         * Render individual element (simplified)
         */
        renderElement(element, rect) {
            const style = window.getComputedStyle(element);
            
            // Draw background
            if (style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
                this.ctx.fillStyle = style.backgroundColor;
                this.ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
            }

            // Draw text content
            if (element.textContent && element.children.length === 0) {
                this.ctx.fillStyle = style.color || '#000000';
                this.ctx.font = `${style.fontSize} ${style.fontFamily}`;
                this.ctx.fillText(
                    element.textContent.slice(0, 50), 
                    rect.left + 5, 
                    rect.top + 20
                );
            }

            // Draw borders
            if (style.borderWidth !== '0px') {
                this.ctx.strokeStyle = style.borderColor || '#000000';
                this.ctx.lineWidth = parseInt(style.borderWidth) || 1;
                this.ctx.strokeRect(rect.left, rect.top, rect.width, rect.height);
            }
        }

        /**
         * Track user event
         */
        trackEvent(type, data) {
            this.state.eventBuffer.push({
                type,
                data,
                timestamp: Date.now()
            });
        }

        /**
         * Flush event buffer
         */
        flushEventBuffer() {
            const events = this.state.eventBuffer.splice(0);
            return events;
        }

        /**
         * Process batch upload
         */
        async processBatchUpload(forceUpload = false) {
            if (!this.state.networkOnline) {
                this.log('Network offline, skipping upload');
                return;
            }

            const framesToUpload = forceUpload 
                ? this.state.frameBuffer.splice(0)
                : this.state.frameBuffer.splice(0, this.config.batchSize);

            if (framesToUpload.length === 0) {
                return;
            }

            this.log(`Uploading ${framesToUpload.length} frames`);

            try {
                await this.uploadFrames(framesToUpload);
            } catch (error) {
                this.log('Upload failed, adding to retry queue', error);
                this.state.retryQueue.push(...framesToUpload);
                this.processRetryQueue();
            }
        }

        /**
         * Upload frames to backend
         */
        async uploadFrames(frames) {
            const payload = {
                sessionId: this.state.sessionId,
                frames: frames,
                metadata: {
                    userAgent: navigator.userAgent,
                    timestamp: Date.now(),
                    url: window.location.href
                }
            };

            const response = await fetch(this.config.endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.apiKey}`,
                    'X-SDK-Version': '1.0.0'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`Upload failed: ${response.status}`);
            }

            this.log('Frames uploaded successfully');
        }

        /**
         * Process retry queue
         */
        async processRetryQueue() {
            if (this.state.retryQueue.length === 0) return;

            const framesToRetry = this.state.retryQueue.splice(0, this.config.batchSize);
            
            try {
                await this.uploadFrames(framesToRetry);
            } catch (error) {
                // Put back in retry queue if we have attempts left
                if (framesToRetry[0].retryCount < this.config.retryAttempts) {
                    framesToRetry.forEach(frame => {
                        frame.retryCount = (frame.retryCount || 0) + 1;
                    });
                    this.state.retryQueue.push(...framesToRetry);
                } else {
                    this.log('Max retry attempts reached, dropping frames');
                }
            }
        }

        /**
         * Send event to backend
         */
        async sendEvent(eventType, data = {}) {
            if (!this.config.endpoint) return;

            try {
                const payload = {
                    sessionId: this.state.sessionId,
                    eventType,
                    data,
                    timestamp: Date.now()
                };

                await fetch(this.config.endpoint.replace('/frames', '/events'), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.config.apiKey}`
                    },
                    body: JSON.stringify(payload)
                });
            } catch (error) {
                this.log('Event send failed', error);
            }
        }

        /**
         * Send heartbeat
         */
        sendHeartbeat() {
            this.sendEvent('heartbeat', {
                frameCount: this.state.frameCount,
                sessionDuration: Date.now() - this.state.startTime,
                bufferSize: this.state.frameBuffer.length
            });
        }

        /**
         * Event handlers
         */
        handleVisibilityChange() {
            if (document.hidden) {
                this.log('Page hidden, pausing capture');
                this.stopCapture();
            } else {
                this.log('Page visible, resuming capture');
                if (this.config.autoStart) {
                    this.startCapture();
                }
            }
        }

        handleBeforeUnload() {
            this.log('Page unloading, stopping capture');
            this.stopCapture();
        }

        handleNetworkChange() {
            this.state.networkOnline = navigator.onLine;
            this.log('Network status changed', { online: this.state.networkOnline });
            
            if (this.state.networkOnline && this.state.retryQueue.length > 0) {
                this.processRetryQueue();
            }
        }

        /**
         * Utility methods
         */
        generateSessionId() {
            return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        }

        getElementSelector(element) {
            if (element.id) return `#${element.id}`;
            if (element.className) return `.${element.className.split(' ')[0]}`;
            return element.tagName.toLowerCase();
        }

        log(message, data = null) {
            if (this.config.debug) {
                console.log(`[DiscountingAI] ${message}`, data);
            }
        }

        /**
         * Public API methods
         */
        getSessionId() {
            return this.state.sessionId;
        }

        getStats() {
            return {
                sessionId: this.state.sessionId,
                isCapturing: this.state.isCapturing,
                frameCount: this.state.frameCount,
                sessionDuration: Date.now() - this.state.startTime,
                bufferSize: this.state.frameBuffer.length,
                retryQueueSize: this.state.retryQueue.length
            };
        }

        destroy() {
            this.log('Destroying SDK instance');
            this.stopCapture();
            
            // Clean up event listeners
            document.removeEventListener('visibilitychange', this.handleVisibilityChange);
            window.removeEventListener('beforeunload', this.handleBeforeUnload);
            window.removeEventListener('online', this.handleNetworkChange);
            window.removeEventListener('offline', this.handleNetworkChange);
            
            // Clear state
            this.state.frameBuffer = [];
            this.state.eventBuffer = [];
            this.state.retryQueue = [];
            this.state.sessionId = null;
        }
    }

    // Create global instance
    window.DiscountingAI = new DiscountingAI();

    // Auto-initialize if config is provided
    if (window.DiscountingAIConfig) {
        window.DiscountingAI.init(window.DiscountingAIConfig);
    }

})(window);

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.DiscountingAI;
}