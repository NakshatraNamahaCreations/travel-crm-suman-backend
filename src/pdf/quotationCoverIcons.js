// Monochrome, print-safe icons for the quotation's package-inclusions strip.
// Inherit the strip's orange so the result is independent of emoji fonts.
const paths = {
  bed: `
    <rect x="3" y="13" width="7" height="44" rx="3.5"/>
    <circle cx="19" cy="26" r="6"/>
    <path d="M12 34h13V23h24c7 0 12 5 12 12v5H12z"/>
    <path d="M11 43h50v14h-6v-7H11z"/>`,
  palm: `
    <path d="M30 23C21 18 15 22 10 32c-1-12 5-20 18-20C18 9 12 10 6 15 11 3 23 2 32 12 37 1 49 2 57 10 47 7 39 10 35 16 49 9 59 16 61 30 53 23 46 19 37 22 49 24 52 34 49 43 46 34 41 27 35 24 39 33 35 39 31 44 32 35 30 29 30 23z"/>
    <path d="M30 26h5c0 11 1 22 5 30H27c4-9 4-20 3-30z"/>
    <path d="M9 60c3-7 12-10 23-10s20 3 23 10z"/>`,
  ferry: `
    <path d="M29 3h7v7h7v4h-7v5h12l4 16-17-5V19h-6v11l-17 5 4-16h13v-5h-7v-4h7z"/>
    <path d="m7 35 22-7v17h6V28l22 7-7 13c-5 1-8-1-11-3-5 4-9 4-14 0-3 2-6 4-11 3z"/>
    <path d="M6 50q7 6 14 0 6 6 12 0 6 6 12 0 7 6 14 0v5q-7 6-14 0-6 6-12 0-6 6-12 0-7 6-14 0zm0 8q7 6 14 0 6 6 12 0 6 6 12 0 7 6 14 0v4H6z"/>`,
  car: `
    <path fill-rule="evenodd" d="M15 8q17-4 34 0l6 18h4q4 0 4 4v3h-6v16q0 4-4 4v5h-8v-7H19v7h-8v-5q-4 0-4-4V33H1v-3q0-4 4-4h4zm3 5-5 15h38l-5-15q-14-3-28 0zM16 34a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm32 0a5 5 0 1 0 0 10 5 5 0 0 0 0-10z"/>`,
  binoculars: `
    <g fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="17" cy="46" r="12"/><circle cx="47" cy="46" r="12"/>
      <path d="m6 41 12-29q2-5 6-4t4 6v29M58 41 46 12q-2-5-6-4t-4 6v29M27 33q5-6 10 0M29 45h6M27 18h10"/>
    </g>`,
  breakfast: `
    <circle cx="33" cy="32" r="22"/>
    <circle cx="33" cy="32" r="17" fill="none" stroke="white" stroke-width="1.5"/>
    <path d="M2 8h2v15h2V8h2v15h2V8h2v18q0 5-4 6v25H5V32q-4-1-4-6V8zM61 7q-5 2-5 20v9h3v21h4V9q0-3-2-2z"/>`,

  // ---- quotation-proposal cells (drawn white on a navy disc) ----
  person: `
    <circle cx="32" cy="20" r="12"/>
    <path d="M8 58c0-14 10-22 24-22s24 8 24 22z"/>`,
  calendar: `
    <path d="M14 8h6v6h24V8h6v6h6q3 0 3 3v36q0 3-3 3H8q-3 0-3-3V17q0-3 3-3h6zM11 26v24h42V26z"/>
    <rect x="16" y="31" width="8" height="7"/><rect x="28" y="31" width="8" height="7"/><rect x="40" y="31" width="8" height="7"/>
    <rect x="16" y="41" width="8" height="7"/><rect x="28" y="41" width="8" height="7"/>`,
  clock: `
    <path fill-rule="evenodd" d="M32 6a26 26 0 1 1 0 52 26 26 0 0 1 0-52zm0 6a20 20 0 1 0 0 40 20 20 0 0 0 0-40zm-3 8h6v13l9 6-3 5-12-8z"/>`,
  group: `
    <circle cx="22" cy="20" r="9"/><circle cx="43" cy="22" r="8"/>
    <path d="M4 52c0-11 8-18 18-18s18 7 18 18zM40 52c0-7-2-12-6-16 3-2 6-3 9-3 9 0 17 6 17 16z"/>`,
  pin: `
    <path fill-rule="evenodd" d="M32 4c11 0 20 9 20 20 0 15-20 36-20 36S12 39 12 24c0-11 9-20 20-20zm0 12a8 8 0 1 0 0 16 8 8 0 0 0 0-16z"/>`,
  mail: `
    <path d="M6 14h52q3 0 3 3v2L32 36 3 19v-2q0-3 3-3zM3 25l29 17 29-17v22q0 3-3 3H6q-3 0-3-3z"/>`,
  phone: `
    <path d="M14 6q3 0 5 3l6 11q1 3-1 5l-4 4q5 11 16 16l4-4q2-2 5-1l11 6q3 2 3 5v6q0 5-5 5Q8 60 6 11q0-5 5-5z"/>`,
};

export const quotationCoverIcon = (name) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true" focusable="false">${paths[name] || ''}</svg>`;
