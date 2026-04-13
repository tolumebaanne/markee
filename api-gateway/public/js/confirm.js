/**
 * Markee Styled Confirmation Dialog
 * Usage: showConfirm('Are you sure?', onConfirmFn)
 * Optional: showConfirm('Are you sure?', onConfirm, onCancel, { confirmText: 'Delete', cancelText: 'Cancel', type: 'danger' })
 */
(function() {
    window.showConfirm = function(message, onConfirm, onCancel, options = {}) {
        const { confirmText = 'Confirm', cancelText = 'Cancel', type = 'default' } = options;

        // Remove any existing confirm modal
        const existing = document.getElementById('confirm-modal-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'confirm-modal-overlay';
        overlay.innerHTML = `
            <div class="confirm-modal">
                <p class="confirm-modal-msg">${message}</p>
                <div class="confirm-modal-actions">
                    <button class="confirm-modal-cancel">${cancelText}</button>
                    <button class="confirm-modal-ok confirm-modal-ok--${type}">${confirmText}</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector('.confirm-modal-cancel').onclick = () => {
            overlay.remove();
            if (onCancel) onCancel();
        };
        overlay.querySelector('.confirm-modal-ok').onclick = () => {
            overlay.remove();
            if (onConfirm) onConfirm();
        };
        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { overlay.remove(); if (onCancel) onCancel(); }
        });
    };
})();
