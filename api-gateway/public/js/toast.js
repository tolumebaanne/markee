/**
 * Markee Toast Notification System
 * Usage: showToast('Message here', 'success' | 'error' | 'info')
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

    window.showToast = function(message, type = 'info', duration = 3500) {
        const container = ensureContainer();
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;

        const icons = { success: 'fa-check-circle', error: 'fa-times-circle', info: 'fa-info-circle' };
        toast.innerHTML = `
            <i class="fa ${icons[type] || 'fa-info-circle'}"></i>
            <span>${message}</span>
            <button class="toast-close" onclick="this.parentElement.remove()">&times;</button>
        `;
        container.appendChild(toast);

        // Trigger animation
        setTimeout(() => toast.classList.add('toast-visible'), 10);

        // Auto-dismiss
        setTimeout(() => {
            toast.classList.remove('toast-visible');
            setTimeout(() => toast.remove(), 400);
        }, duration);
    };
})();
