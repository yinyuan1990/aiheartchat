import { useNavigate } from 'react-router-dom';
import { t } from '../i18n';

/** token 失效后的重新进入页 */
export function EnterPage() {
  const nav = useNavigate();
  return (
    <div className="app">
      <div className="page" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div className="page-title" style={{ textAlign: 'center', fontSize: 30 }}>{t('app.name')}</div>
        <p className="hint">{t('enter.sessionExpired')}</p>
        <button className="btn mt16" onClick={() => nav('/', { replace: true })}>{t('enter.reenter')}</button>
        <p className="hint" style={{ marginTop: 10 }}>
          {t('enter.ageNotice')}
          <span style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => nav('/agreement/user')}>{t('register.userAgreement')}</span>
          {t('register.and')}
          <span style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => nav('/agreement/privacy')}>{t('register.privacyPolicy')}</span>
        </p>
      </div>
    </div>
  );
}
