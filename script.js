document.addEventListener('DOMContentLoaded', () => {
    const navItems = document.querySelectorAll('.nav-item');
    const pages = document.querySelectorAll('.page');
    const pageTitle = document.getElementById('page-title');
// Page Switching Logic
navItems.forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();

        const targetPage = item.getAttribute('data-page');

        // Update Navigation UI
        navItems.forEach(nav => nav.classList.remove('active'));
        item.classList.add('active');

        // Update Visible Page
        pages.forEach(page => {
            page.classList.remove('active');
            if (page.id === targetPage) {
                page.classList.add('active');
            }
        });

        // Update Header Title
        pageTitle.textContent = item.querySelector('span:last-child').textContent;
    });
});

// Modal Logic
const fabBtn = document.querySelector('.fab');
const modal = document.getElementById('create-class-modal');
const cancelBtn = document.getElementById('cancel-class');
const submitBtn = document.getElementById('submit-class');
const classNameInput = document.getElementById('class-name');

fabBtn.addEventListener('click', () => {
    modal.classList.add('active');
    classNameInput.focus();
});

const closeModal = () => {
    modal.classList.remove('active');
    classNameInput.value = '';
};

cancelBtn.addEventListener('click', closeModal);

// Close modal when clicking outside content
modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
});

submitBtn.addEventListener('click', () => {
    const className = classNameInput.value.trim();
    if (className) {
        alert(`Class "${className}" created successfully!`);
        // Here you would typically add logic to save the class
        closeModal();
    } else {
        alert('Please enter a class name.');
    }
});

// Accordion Toggle Logic
const accordionHeaders = document.querySelectorAll('.accordion-header');

accordionHeaders.forEach(header => {
    header.addEventListener('click', (e) => {
        // Prevent toggle if clicking on action buttons (like call)
        if (e.target.closest('.icon-btn')) return;

        const parent = header.parentElement;
        parent.classList.toggle('open');
    });
});

// Handle Call Buttons separately
const callButtons = document.querySelectorAll('.call-btn');
callButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.stopPropagation(); // Double safety
        const name = btn.closest('.student-card').querySelector('h4').textContent;
        alert(`Initiating call to ${name}...`);
    });
});

// Settings Item Logic
const settingsItems = document.querySelectorAll('.settings-item');
settingsItems.forEach(item => {
    item.addEventListener('click', () => {
        const action = item.getAttribute('data-action');
        const label = item.querySelector('h4').textContent;

        switch(action) {
            case 'export-csv':
            case 'export-excel':
                alert(`Preparing ${label}. Download will start shortly...`);
                break;
            case 'monthly-bill':
            case 'admit-marksheet':
            case 'id-card':
                alert(`Opening ${label} generator...`);
                break;
            case 'send-sms':
                alert('Opening SMS Compose window...');
                break;
            case 'support':
                alert('Redirecting to Help & Support center...');
                break;
            default:
                alert(`Opening ${label} settings...`);
        }
    });
});
});
