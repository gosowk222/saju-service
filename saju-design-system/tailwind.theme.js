// 사주풀이 디자인 시스템 v1.3 — Tailwind theme.extend
// tailwind.config.js 의 theme.extend 에 그대로 spread 하거나, Tailwind 4라면 @theme 블록으로 옮겨 쓰세요.
module.exports = {
  colors: {
    primary: { 50: '#F3F1FD', 100: '#E6E2FB', 200: '#CFC7F7', 300: '#B3A6F3', 400: '#9D8DF8', 500: '#8B7CF6', 600: '#6E5CE6', 700: '#5748C4', 900: '#2B2457', DEFAULT: '#6E5CE6' },
    gray:    { 50: '#F7F6FC', 100: '#ECEAF5', 200: '#DCD9EA', 300: '#C9C6DC', 400: '#A9A6C0', 500: '#716D8E', 600: '#625E80', 700: '#4A4668', 800: '#322E52', 900: '#262345' },
    rose:    { 50: '#FDE8EF', 400: '#F28BB3', 600: '#C2366B' },
    gold:    { 50: '#FFF4D6', 300: '#F7D98A', 400: '#F2B544', 700: '#9A6700', 800: '#5C3D00' },
    blue:    { 50: '#E3EEFC', 400: '#6FA8F0', 600: '#2B63C6', 900: '#1E4A9A' },
    green:   { 50: '#E1F5EE', 400: '#5CC0A0', 600: '#257F60' },
    orange:  { 50: '#FFEBD9', 400: '#F39A4A', 600: '#B55A12' },
    kakao:   { DEFAULT: '#FEE500', text: '#191600' },
    'on-gold': '#4A3200',
  },
  fontFamily: {
    sans:  ['Noto Sans KR', 'Pretendard', '-apple-system', 'system-ui', 'sans-serif'],
    serif: ['Noto Serif KR', 'Nanum Myeongjo', 'serif'],
  },
  fontSize: {
    'display':   ['44px', { lineHeight: '52px', letterSpacing: '-0.01em', fontWeight: '700' }],
    'heading-1': ['32px', { lineHeight: '40px', fontWeight: '700' }],
    'heading-2': ['24px', { lineHeight: '32px', fontWeight: '600' }],
    'heading-3': ['20px', { lineHeight: '28px', fontWeight: '600' }],
    'title':     ['18px', { lineHeight: '26px', fontWeight: '600' }],
    'body-lg':   ['17px', { lineHeight: '26px' }],
    'body':      ['15px', { lineHeight: '22px' }],
    'label':     ['14px', { lineHeight: '20px', fontWeight: '500' }],
    'caption':   ['12px', { lineHeight: '16px' }],
    'caption-sm':['11px', { lineHeight: '14px', fontWeight: '500' }],
    'hanja':     ['28px', { lineHeight: '1', letterSpacing: '0.02em', fontWeight: '500' }],
  },
  spacing: { 1: '2px', 2: '4px', 3: '8px', 4: '12px', 5: '16px', 6: '20px', 7: '24px', 8: '32px', 9: '40px', 10: '52px', 11: '120px' },
  borderRadius: { sm: '8px', md: '12px', lg: '16px', pill: '22px', xl: '24px', full: '9999px' },
  boxShadow: { float: '0 4px 16px rgba(38,35,69,0.08)', focus: '0 0 0 2px #6E5CE6, 0 0 0 5px #E6E2FB' },
  transitionDuration: { fast: '150ms', base: '200ms', slow: '300ms' },
  transitionTimingFunction: { standard: 'cubic-bezier(0.4, 0, 0.2, 1)', exit: 'cubic-bezier(0.4, 0, 1, 1)' },
  screens: { compact: '375px', medium: '480px', desktop: '768px', wide: '1024px', xwide: '1280px', max: '1440px' },
  maxWidth: { content: '600px' },
  backgroundImage: {
    scrim: 'linear-gradient(to top, rgba(0,0,0,0.72), rgba(0,0,0,0) 60%)',
    'gradient-primary': 'linear-gradient(135deg, #9D8DF8, #6E5CE6)',
  },
};
