// telemetry.js - Smart Catalog Behavior Tracking
(function() {
    let dwellInterval = null;
    let secondsDwelled = 0;
    let hasSentView = false;
    let observer = null;
    let isVisible = true; 

    // Expose sendTelemetry globally so cart interactions can dispatch directly
    window.sendTelemetry = function(event, overrides = {}) {
        if (typeof window.PRODUCT_ID === 'undefined' && !overrides.productId) return;
        const targetId = overrides.productId || window.PRODUCT_ID;
        
        const payload = {
            event: event,
            duration: secondsDwelled,
            ...overrides
        };

        const token = localStorage.getItem('access_token');
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        fetch(`/api/catalog/products/${targetId}/telemetry`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload),
            keepalive: true
        }).catch(err => console.error('Telemetry error:', err));
    };

    function startTimer() {
        if (!hasSentView) {
            window.sendTelemetry('viewed');
            hasSentView = true;
        }
        if (dwellInterval) return;
        dwellInterval = setInterval(() => {
            if (isVisible) secondsDwelled++;
        }, 1000);
    }

    function stopTimer() {
        if (dwellInterval) {
            clearInterval(dwellInterval);
            dwellInterval = null;
        }
    }

    // Attach to primary rendering column for dwelled context
    window.addEventListener('load', () => {
        const target = document.querySelector('.main-column');
        if (!target) return;

        observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    startTimer();
                } else {
                    stopTimer();
                }
            });
        }, { threshold: 0.25 });
        
        observer.observe(target);
    });

    document.addEventListener("visibilitychange", () => {
        isVisible = !document.hidden;
    });

    // Send final dwell time on exit, if significant
    window.addEventListener('beforeunload', () => {
        if (secondsDwelled >= 5) { 
            window.sendTelemetry('dwelled');
        }
    });

})();
