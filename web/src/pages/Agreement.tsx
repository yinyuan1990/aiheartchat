import { useNavigate, useParams } from 'react-router-dom';
import { t } from '../i18n';

export const USER_AGREEMENT = t('agreement.web.user', { app: t('app.name') });

export const PRIVACY_POLICY = t('agreement.web.privacy', { app: t('app.name') });

/** 用户协议 / 隐私政策（免登录可看） */
export function AgreementPage() {
  const nav = useNavigate();
  const { type } = useParams();
  const isPrivacy = type === 'privacy';
  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹</span>
        <span className="title">{isPrivacy ? t('agreement.web.privacyTitle') : t('agreement.web.userTitle')}</span>
      </div>
      <div className="page page-pad" style={{ paddingTop: 56 }}>
        <div style={{ fontSize: 14, lineHeight: 1.9, whiteSpace: 'pre-wrap', color: 'var(--text-2)', paddingBottom: 32 }}>
          {isPrivacy ? PRIVACY_POLICY : USER_AGREEMENT}
        </div>
      </div>
    </div>
  );
}
