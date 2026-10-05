/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        './index.html',
        './admin.html',
        './script.js'
    ],
    // Classes constructed at runtime (template literals) can't be seen by
    // the scanner. This safelist keeps them in the compiled CSS. Anything
    // you generate as `bg-${color}-600` or `badge-${status}` MUST be listed
    // here, otherwise the class won't exist in production.
    safelist: [
        // Toast backgrounds (showNotify types)
        'bg-green-600',
        'bg-red-600',
        'bg-blue-600',

        // Tab active/inactive states (switchTab)
        'bg-slate-800',

        // Status badges are already defined in style.css as custom classes,
        // so we don't need them here. But if you ever inline them:
        // 'badge-novo', 'badge-limitado', 'badge-recomendado',

        // Grid fade + page blur transitions (toggled by class in JS)
        'grid-fade-out',
        'page-blurred',
        'curtain-hide',
        'content-ready',
        'toast-in',
        'toast-out',
        'fade-anim',
        'has-value',
        'show'
    ],
    theme: {
        extend: {
            fontFamily: {
                display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
                mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace']
            }
        }
    },
    plugins: []
};
