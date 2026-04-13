/**
 * Markee Toast Notification System
 * Usage:
 *   showToast('Message here', 'success' | 'error' | 'info' | 'warning')
 *   showToast('Message here', 'success', 3500, event)        // appears near clicked element
 *   showToast('Message here', 'success', 3500, buttonElement) // appears near specific element
 */
(function() {
    function ensureContainer() {
        let c = document.getElementById('toast-container');
        if (!c) {
            c = document.createElement('div');
            c.id = 'toast-container';
            document.body.appendChild(c);
        }
        return c;
    }

    const icons = { success: 'fa-check-circle', error: 'fa-times-circle', info: 'fa-info-circle', warning: 'fa-exclamation-triangle' };

    function buildToast(message, type) {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
            <i class="fa ${icons[type] || 'fa-info-circle'}"></i>
            <span>${message}</span>
            <button class="toast-close" onclick="this.parentElement.remove()">&times;</button>
        `;
        return toast;
    }

    window.showToast = function(message, type = 'info', duration = 3500, anchor = null) {
        const toast = buildToast(message, type);

        if (anchor) {
            const el = (anchor instanceof Event) ? anchor.currentTarget || anchor.target : anchor;
            let rect;
            try { rect = el.getBoundingClientRect(); } catch(e) { anchor = null; }

            if (rect) {
                // Position near the anchor element
                const toastWidth = 260;
                let top = rect.bottom + 8;
                let left = rect.left + rect.width / 2 - toastWidth / 2;

                // Clamp to viewport
                if (left < 8) left = 8;
                if (left + toastWidth > window.innerWidth - 8) left = window.innerWidth - toastWidth - 8;

                // Flip above if not enough room below
                if (top + 60 > window.innerHeight) top = rect.top - 60;

                toast.style.cssText = `position:fixed; top:${top}px; left:${left}px; width:${toastWidth}px; z-index:99999; margin:0;`;
                toast.classList.add('toast-anchored');
                document.body.appendChild(toast);

                setTimeout(() => toast.classList.add('toast-visible'), 10);
                setTimeout(() => {
                    toast.classList.remove('toast-visible');
                    setTimeout(() => toast.remove(), 400);
                }, duration);
                return;
            }
        }

        // Default: append to container (top-right)
        const container = ensureContainer();
        container.appendChild(toast);
        setTimeout(() => toast.classList.add('toast-visible'), 10);
        setTimeout(() => {
            toast.classList.remove('toast-visible');
            setTimeout(() => toast.remove(), 400);
        }, duration);
    };
})();
