// PawTrack Booking Dashboard
// Connects to the PawTrack API at localhost:3001

const API_BASE = 'http://localhost:3001';

// Simulated auth context — in production this would come from a login flow
const AUTH_HEADERS = {
  'X-Tenant-Id': 'tenant_portland',
  'X-User-Id': 'user_staff_portland',
  'X-User-Role': 'staff',
  'Content-Type': 'application/json',
};

// Current filter state
let filters = {
  date: '',
  status: '',
  page: 1,
};

// ============================================
// Security helpers
// ============================================

/**
 * Escape user-controlled strings before inserting them into innerHTML.
 * Without this, a booking note containing <script> or <img onerror=...>
 * would execute arbitrary JavaScript in every user's browser (stored XSS).
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================
// Initialization
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  initTenantInfo();
  initFilters();
  initNewBookingForm();
  fetchBookings(filters);
  loadPetsAndSitters();

  // Poll for booking updates every 15 seconds
  setInterval(() => {
    fetchBookings(filters);
  }, 15000);
});

function initTenantInfo() {
  const el = document.getElementById('tenant-info');
  el.textContent = `Tenant: PawTrack Portland | User: Staff`;
}

// ============================================
// Filters
// ============================================

function initFilters() {
  const dateFilter = document.getElementById('date-filter');
  const statusFilter = document.getElementById('status-filter');
  const refreshBtn = document.getElementById('refresh-btn');

  dateFilter.addEventListener('change', (e) => {
    filters = { ...filters, date: e.target.value, page: 1 };
    fetchBookings(filters);
  });

  statusFilter.addEventListener('change', (e) => {
    filters = { ...filters, status: e.target.value, page: 1 };
    fetchBookings(filters);
  });

  refreshBtn.addEventListener('click', () => {
    fetchBookings(filters);
  });
}

// ============================================
// Fetch and Render Bookings
// ============================================

async function fetchBookings(currentFilters) {
  const loadingEl = document.getElementById('loading-indicator');
  const errorEl = document.getElementById('error-message');
  const listEl = document.getElementById('bookings-list');

  loadingEl.style.display = 'block';
  errorEl.style.display = 'none';

  const params = new URLSearchParams();
  params.set('page', String(currentFilters.page));
  params.set('limit', '5');
  if (currentFilters.date) params.set('date', currentFilters.date);
  if (currentFilters.status) params.set('status', currentFilters.status);

  try {
    const response = await fetch(`${API_BASE}/api/bookings?${params}`, {
      headers: AUTH_HEADERS,
    });
    const result = await response.json();

    loadingEl.style.display = 'none';

    if (result.error) {
      errorEl.textContent = result.error;
      errorEl.style.display = 'block';
      return;
    }

    renderBookings(result.data, listEl);
    renderPagination(result);
  } catch (err) {
    loadingEl.style.display = 'none';
    errorEl.textContent = 'Failed to load bookings. Is the server running?';
    errorEl.style.display = 'block';
  }
}

function renderBookings(bookings, container) {
  if (!bookings || bookings.length === 0) {
    container.innerHTML = '<p style="text-align: center; color: #999; padding: 2rem;">No bookings found.</p>';
    return;
  }

  container.innerHTML = bookings.map(booking => {
    const date = new Date(booking.scheduledDate).toLocaleDateString();
    const statusActions = getStatusActions(booking);

    return `
      <div class="booking-card">
        <div class="booking-info">
          <h3>Booking ${escapeHtml(booking.id.replace('booking_', '#'))}</h3>
          <div class="booking-meta">
            <span>Pet: ${escapeHtml(booking.petId)}</span>
            <span>Sitter: ${escapeHtml(booking.sitterId)}</span>
            <span>Date: ${escapeHtml(date)}</span>
            <span>Time: ${escapeHtml(booking.startTime)} - ${escapeHtml(booking.endTime)}</span>
          </div>
          <div class="booking-notes">${escapeHtml(booking.notes)}</div>
        </div>
        <div class="booking-actions">
          <span class="status-badge status-${escapeHtml(booking.status)}">
            ${escapeHtml(booking.status.replace('_', ' '))}
          </span>
          ${statusActions}
        </div>
      </div>
    `;
  }).join('');

  // Attach status transition handlers
  container.querySelectorAll('[data-action="transition"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const bookingId = btn.dataset.bookingId;
      const newStatus = btn.dataset.newStatus;
      transitionStatus(bookingId, newStatus);
    });
  });
}

function getStatusActions(booking) {
  const transitions = {
    requested: ['confirmed', 'cancelled'],
    confirmed: ['in_progress', 'cancelled'],
    in_progress: ['completed'],
    completed: [],
    cancelled: [],
  };

  const actions = transitions[booking.status] || [];
  return actions.map(status => {
    const label = status.replace('_', ' ');
    const btnClass = status === 'cancelled' ? 'btn-secondary' : 'btn-primary';
    return `<button class="btn btn-sm ${btnClass}" data-action="transition" data-booking-id="${booking.id}" data-new-status="${status}">${label}</button>`;
  }).join('');
}

async function transitionStatus(bookingId, newStatus) {
  try {
    const response = await fetch(`${API_BASE}/api/bookings/${bookingId}/status`, {
      method: 'PATCH',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ status: newStatus }),
    });
    const result = await response.json();

    if (result.success) {
      showToast(`Booking updated to ${newStatus.replace('_', ' ')}`, 'success');
      fetchBookings(filters);
    } else {
      showToast(result.error || 'Failed to update status', 'error');
    }
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
  }
}

// ============================================
// Pagination
// ============================================

function renderPagination(result) {
  const paginationEl = document.getElementById('pagination');
  const { page, totalPages } = result;

  if (totalPages <= 1) {
    paginationEl.innerHTML = '';
    return;
  }

  let html = '';
  html += `<button ${page <= 1 ? 'disabled' : ''} onclick="goToPage(${page - 1})">Prev</button>`;

  for (let i = 1; i <= totalPages; i++) {
    html += `<button class="${i === page ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
  }

  html += `<button ${page >= totalPages ? 'disabled' : ''} onclick="goToPage(${page + 1})">Next</button>`;
  paginationEl.innerHTML = html;
}

function goToPage(page) {
  filters = { ...filters, page };
  fetchBookings(filters);
}

// ============================================
// New Booking Form
// ============================================

function initNewBookingForm() {
  const modal = document.getElementById('booking-modal');
  const openBtn = document.getElementById('new-booking-btn');
  const cancelBtn = document.getElementById('cancel-booking');
  const form = document.getElementById('booking-form');

  openBtn.addEventListener('click', () => {
    modal.style.display = 'flex';
  });

  cancelBtn.addEventListener('click', () => {
    modal.style.display = 'none';
    form.reset();
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.style.display = 'none';
      form.reset();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await createBooking();
  });
}

async function loadPetsAndSitters() {
  try {
    const [petsRes, sittersRes] = await Promise.all([
      fetch(`${API_BASE}/api/pets`, { headers: AUTH_HEADERS }),
      fetch(`${API_BASE}/api/sitters`, { headers: AUTH_HEADERS }),
    ]);

    const petsData = await petsRes.json();
    const sittersData = await sittersRes.json();

    const petSelect = document.getElementById('pet-select');
    for (const pet of petsData.data) {
      const option = document.createElement('option');
      option.value = pet.id;
      option.textContent = `${pet.name} (${pet.species} - ${pet.ownerName})`;
      petSelect.appendChild(option);
    }

    const sitterSelect = document.getElementById('sitter-select');
    for (const sitter of sittersData.data) {
      const option = document.createElement('option');
      option.value = sitter.id;
      option.textContent = `${sitter.name}`;
      sitterSelect.appendChild(option);
    }
  } catch (err) {
    console.error('Failed to load pets and sitters:', err);
  }
}

async function createBooking() {
  const form = document.getElementById('booking-form');
  const modal = document.getElementById('booking-modal');

  const body = {
    petId: document.getElementById('pet-select').value,
    sitterId: document.getElementById('sitter-select').value,
    scheduledDate: new Date(document.getElementById('booking-date').value).toISOString(),
    startTime: document.getElementById('start-time').value,
    endTime: document.getElementById('end-time').value,
    notes: document.getElementById('booking-notes').value,
  };

  try {
    const response = await fetch(`${API_BASE}/api/bookings`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify(body),
    });
    const result = await response.json();

    if (result.success) {
      showToast('Booking created!', 'success');
      modal.style.display = 'none';
      form.reset();
      fetchBookings(filters);
    } else {
      showToast(result.error || 'Failed to create booking', 'error');
    }
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
  }
}

// ============================================
// Toast Notifications
// ============================================

function showToast(message, type) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
}

// Make goToPage available globally for inline onclick handlers
window.goToPage = goToPage;
