/* ============================================================
 * config.js — 앱 설정. 이 파일만 고치면 클라우드 동기화가 켜진다.
 *
 * 1) https://supabase.com 에서 무료 프로젝트 생성
 * 2) Supabase 대시보드 → SQL Editor 에 supabase_setup.sql 붙여넣고 RUN
 *    (기본값이 '로그인 필수 + 비공개 사진' 모드입니다)
 * 3) Authentication → Sign In / Providers → Email 의 'Allow new users to sign up' 끄기
 *    → Authentication → Users → Add user 로 본인 이메일·비밀번호 계정 1개만 추가
 * 4) Settings → API 에서 Project URL 과 anon public key 를 복사해 아래에 입력
 * 5) 저장 후 새로고침 → 로그인 화면이 뜨고, 로그인하면 '동기화됨' 으로 바뀐다.
 *
 * 비워두면 로그인 없이 로컬(IndexedDB) 미리보기 모드로만 동작한다. (폰/PC 각각 따로 저장됨)
 * ============================================================ */
window.MEMO_CONFIG = {
  supabaseUrl: 'https://bprsxpenvfitujdmfybx.supabase.co',        // 예: 'https://abcdefghijklmnop.supabase.co'
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJwcnN4cGVudmZpdHVqZG1meWJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUyNDg4MjMsImV4cCI6MjExMDgyNDgyM30.d8-Go8mQBCqGH6_Jxt-CCeuFv6SDtyHqy6aOG1GlTbE',    // 예: 'eyJhbGciOiJIUzI1NiIsInR5cCI6...' (anon public)
  table: 'memos',
  bucket: 'memo-images',
  syncIntervalMs: 8000    // 자동 동기화 주기(ms). 무료 플랜 트래픽을 아끼려면 15000~30000 권장
};
