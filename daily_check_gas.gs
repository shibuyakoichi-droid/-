// ============================================================
// デイリーチェック メール送信 GAS
// トリガー: 毎日 20:00
// 送信先: shibuya.koichi@gmail.com
// ============================================================

const SB_URL = 'https://yukcdqnnevomhdcpsvms.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl1a2NkcW5uZXZvbWhkY3Bzdm1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0Mjc2MTUsImV4cCI6MjA5MjAwMzYxNX0.XBSc2kQNwR_bleSwrfYZD8l0fbKTbL1Z3S7ewEtSkDc';
const MAIL_TO = 'shibuya.koichi@gmail.com';

function sendDailyCheckReport() {
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const dow = new Date().getDay(); // 0=日, 1=月...6=土
  const dom = new Date().getDate();
  const lastDay = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();

  // スタッフ・タスク・ログを取得
  const staff   = sbGet('dc_staff?select=*&order=sort_order');
  const allTasks= sbGet('dc_tasks?select=*&eq.active=true&order=staff_id,sort_order');
  const logs    = sbGet('dc_logs?select=*&date=eq.' + today);

  if (!staff || !allTasks) {
    Logger.log('データ取得失敗');
    return;
  }

  const logMap = {};
  (logs || []).forEach(l => logMap[l.task_id] = l);

  // 今日対象のタスクをフィルタ
  function isOnDate(task) {
    const wd = JSON.parse(task.weekdays || '[]');
    switch (task.pattern) {
      case 'daily':         return true;
      case 'weekday':       return dow >= 1 && dow <= 5;
      case 'weekly':        return wd.includes(dow);
      case 'monthly-start': return dom <= 3;
      case 'monthly-end':   return dom >= lastDay - 2;
    }
    return false;
  }

  let totalTasks = 0, totalDone = 0;
  let bodyText = '', bodyHtml = '';

  const timingLabel = { checkin: '出勤', work: '業務', checkout: '退勤' };

  staff.forEach(s => {
    const myTasks = allTasks.filter(t => t.staff_id === s.id && isOnDate(t));
    if (!myTasks.length) return;

    const done = myTasks.filter(t => logMap[t.id]).length;
    totalTasks += myTasks.length;
    totalDone  += done;
    const pct = Math.round(done / myTasks.length * 100);

    bodyText += `\n【${s.name}】${s.role ? '（' + s.role + '）' : ''} ${done}/${myTasks.length}完了 ${pct}%\n`;
    bodyHtml += `<h3 style="margin:16px 0 6px;font-size:15px">${s.name}<span style="font-size:12px;color:#888;font-weight:normal"> ${s.role || ''} &nbsp; ${done}/${myTasks.length}完了 ${pct}%</span></h3><table style="border-collapse:collapse;width:100%">`;

    ['checkin', 'work', 'checkout'].forEach(timing => {
      const items = myTasks.filter(t => t.timing === timing);
      if (!items.length) return;
      items.forEach(t => {
        const log = logMap[t.id];
        const mark = log ? '✅' : '❌';
        let timeStr = '';
        if (log) {
          const d = new Date(log.checked_at);
          timeStr = (d.getHours() + 9) % 24 + ':' + String(d.getMinutes()).padStart(2, '0'); // UTC→JST
          // checked_atはUTCで保存されているため+9h換算（簡易）
        }
        bodyText += `  ${mark} [${timingLabel[timing]}] ${t.name}${timeStr ? '  ' + timeStr : ''}\n`;
        const bg = log ? '#e1f5ee' : '#fcebeb';
        const color = log ? '#085041' : '#a32d2d';
        bodyHtml += `<tr style="background:${bg}"><td style="padding:6px 10px;font-size:13px;color:${color}">${mark}</td><td style="padding:6px 4px;font-size:11px;color:#888">${timingLabel[timing]}</td><td style="padding:6px 10px;font-size:13px;flex:1">${t.name}</td><td style="padding:6px 10px;font-size:12px;color:#888;text-align:right">${timeStr}</td></tr>`;
      });
    });
    bodyHtml += '</table>';
  });

  const pctTotal = totalTasks > 0 ? Math.round(totalDone / totalTasks * 100) : 0;
  const subject = `[デイリーチェック] ${today} 完了 ${totalDone}/${totalTasks}（${pctTotal}%）`;

  const textBody = `SOWAN デイリーチェック ${today}\n${'='.repeat(40)}\n${bodyText}\n合計: ${totalDone}/${totalTasks}件完了 (${pctTotal}%)`;

  const htmlBody = `
    <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
      <div style="background:#1a1a1a;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
        <div style="font-size:18px;font-weight:700">✓ デイリーチェック</div>
        <div style="font-size:13px;color:#aaa;margin-top:2px">${today}</div>
      </div>
      <div style="background:#f5f4f0;padding:12px 20px;display:flex;gap:24px;border-bottom:1px solid #e8e6e0">
        <div><span style="font-size:11px;color:#888">全タスク</span><br><strong style="font-size:20px">${totalTasks}</strong></div>
        <div><span style="font-size:11px;color:#888">完了</span><br><strong style="font-size:20px;color:#0a6b50">${totalDone}</strong></div>
        <div><span style="font-size:11px;color:#888">未完了</span><br><strong style="font-size:20px;color:#b86a00">${totalTasks - totalDone}</strong></div>
        <div><span style="font-size:11px;color:#888">達成率</span><br><strong style="font-size:20px">${pctTotal}%</strong></div>
      </div>
      <div style="background:#fff;padding:16px 20px;border-radius:0 0 8px 8px;border:1px solid #e8e6e0;border-top:none">
        ${bodyHtml}
      </div>
      <div style="text-align:center;padding:12px;font-size:11px;color:#bbb">SOWAN 自動送信 — デイリーチェックツール</div>
    </div>`;

  GmailApp.sendEmail(MAIL_TO, subject, textBody, { htmlBody });
  Logger.log('送信完了: ' + subject);
}

// Supabase REST API ヘルパー
function sbGet(path) {
  const res = UrlFetchApp.fetch(SB_URL + '/rest/v1/' + path, {
    headers: {
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
    },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    Logger.log('sbGet error: ' + res.getContentText());
    return null;
  }
  return JSON.parse(res.getContentText());
}
