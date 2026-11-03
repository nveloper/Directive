// Directive demo: the real app.js, with the server replaced by this file.
//
// Every request the app makes to /api/... is answered here from sample data
// held in memory, so the interface can be tried on a static host such as
// GitHub Pages. Changes last until the page is reloaded. Nothing is sent
// anywhere.
(function () {
  'use strict';

  window.DIRECTIVE_DEMO = true;

  var KO = ((navigator.languages && navigator.languages[0]) || navigator.language || 'en').toLowerCase().indexOf('ko') === 0;
  function L(en, ko) { return KO ? ko : en; }

  // ---- dates relative to today, so the sample always looks current ----
  function iso(d) { function p(n) { return (n < 10 ? '0' : '') + n; } return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  function day(offset) { var d = new Date(); d.setDate(d.getDate() + offset); return iso(d); }
  function stamp(minutesAgo) { return new Date(Date.now() - minutesAgo * 60000).toISOString(); }
  var TODAY = day(0);

  // ---- sample data ----
  var me = { id: 1, username: 'minji', displayName: L('Minji Kim', '김민지'), role: 'admin', status: 'active', deptId: '', mustChangePassword: false };
  var users = [
    me,
    { id: 2, username: 'seoyeon', displayName: L('Seoyeon Lee', '이서연'), role: 'member', status: 'active', deptId: 'design' },
    { id: 3, username: 'jiho', displayName: L('Jiho Park', '박지호'), role: 'member', status: 'active', deptId: 'marketing' },
    { id: 4, username: 'yuna', displayName: L('Yuna Choi', '최유나'), role: 'member', status: 'active', deptId: 'engineering/frontend' },
    { id: 5, username: 'hoon', displayName: L('Hoon Jung', '정훈'), role: 'member', status: 'active', deptId: 'engineering/backend' }
  ];
  var depts = [
    { id: 'engineering', name: L('Engineering', '개발'), parentId: '', calendarList: '', tag: '', feedToken: 'demo1', color: '' },
    { id: 'engineering/frontend', name: L('Frontend', '프론트엔드'), parentId: 'engineering', calendarList: '', tag: '', feedToken: 'demo2', color: '' },
    { id: 'engineering/backend', name: L('Backend', '백엔드'), parentId: 'engineering', calendarList: '', tag: '', feedToken: 'demo3', color: '' },
    { id: 'design', name: L('Design', '디자인'), parentId: '', calendarList: '', tag: '', feedToken: 'demo4', color: '' },
    { id: 'marketing', name: L('Marketing', '마케팅'), parentId: '', calendarList: '', tag: '', feedToken: 'demo5', color: '' }
  ];
  var nextId = 100;
  function task(id, title, deptId, who, priority, due, status, extra) {
    var u = users.filter(function (x) { return x.id === who; })[0];
    var t = { id: id, title: title, description: '', commentCount: 0, deptId: deptId, assignee: u ? u.displayName : '', assigneeId: u ? u.id : 0,
      priority: priority, dueDate: due, status: status, overdue: false, calendarVisible: true, recurrence: '', icon: '',
      attachmentCount: 0, checklistTotal: 0, checklistDone: 0, createdByName: me.displayName, updatedAt: stamp(60), deleted: false };
    for (var k in extra || {}) t[k] = extra[k];
    return t;
  }
  var tasks = [
    task(1, L('Migrate the auth service to OAuth 2.1', '인증 서비스를 OAuth 2.1로 이전'), 'engineering/backend', 5, 'High', day(1), 'inprogress', { description: L('Token store first, then a staged rollout.\nSpec: https://oauth.net/2.1/', '토큰 저장소부터, 그다음 단계적으로 배포합니다.\n명세: https://oauth.net/2.1/') }),
    task(2, L('Fix chart rendering on Safari', 'Safari에서 차트가 안 그려지는 문제'), 'engineering/frontend', 4, 'High', day(-2), 'todo'),
    task(3, L('Redesign the onboarding flow', '온보딩 흐름 다시 디자인'), 'design', 2, 'Medium', day(0), 'review'),
    task(4, L('Design tokens v2', '디자인 토큰 v2'), 'design', 2, 'Low', day(9), 'todo'),
    task(5, L('Q4 campaign landing page copy', '4분기 캠페인 랜딩 페이지 문구'), 'marketing', 3, 'Medium', day(4), 'inprogress'),
    task(6, L('Weekly metrics report', '주간 지표 보고서'), 'marketing', 1, 'Low', day(3), 'todo', { recurrence: 'FREQ=WEEKLY' }),
    task(7, L('Database index audit', '데이터베이스 인덱스 점검'), 'engineering/backend', 5, 'Low', day(12), 'todo'),
    task(8, L('Release notes 1.4', '1.4 릴리스 노트'), 'engineering', 1, 'Medium', day(-1), 'done'),
    task(9, L('Press kit update', '보도 자료 갱신'), 'marketing', 3, 'Low', day(-5), 'todo', { calendarVisible: false }),
    task(10, L('Accessibility pass on forms', '폼 접근성 점검'), 'engineering/frontend', 4, 'Medium', day(6), 'todo'),
    task(11, L('Customer interview synthesis', '고객 인터뷰 정리'), 'design', 2, 'High', day(2), 'inprogress'),
    task(12, L('Quarterly planning deck', '분기 계획 발표 자료'), '', 1, 'Medium', day(7), 'todo', { icon: '📊' })
  ];
  var checklist = [
    { id: 1, taskId: 1, body: L('Write the spec', '명세 작성'), done: true, position: 0 },
    { id: 2, taskId: 1, body: L('Token store', '토큰 저장소'), done: false, position: 1 },
    { id: 3, taskId: 1, body: L('Staged rollout', '단계적 배포'), done: false, position: 2 },
    { id: 4, taskId: 3, body: L('Wireframes', '와이어프레임'), done: true, position: 0 },
    { id: 5, taskId: 3, body: L('Prototype review', '프로토타입 리뷰'), done: true, position: 1 }
  ];
  var comments = [
    { id: 1, taskId: 1, authorId: 5, authorName: users[4].displayName, body: L('Token store schema is up for review.', '토큰 저장소 스키마 리뷰 부탁드립니다.'), createdAt: stamp(300) },
    { id: 2, taskId: 1, authorId: 1, authorName: me.displayName, body: L('@hoon looks good, ship the first stage.', '@hoon 좋아요, 1단계 배포해 주세요.'), createdAt: stamp(120) },
    { id: 3, taskId: 3, authorId: 2, authorName: users[1].displayName, body: L('Ready for review — prototype link in the description.', '리뷰 준비됐습니다.'), createdAt: stamp(45) }
  ];
  var activity = [];
  var actId = 1;
  function log(actor, verb, subject, subjectId, summary, minutesAgo) {
    activity.unshift({ id: actId++, at: stamp(minutesAgo || 0), actorId: actor.id, actorName: actor.displayName, verb: verb, subject: subject, subjectId: String(subjectId), summary: summary });
  }
  tasks.forEach(function (t, i) { log(me, 'created', 'task', t.id, t.title, 2000 - i * 30); });
  log(users[4], 'updated', 'task', 1, tasks[0].title, 400);
  log(users[4], 'commented on', 'task', 1, tasks[0].title, 300);
  log(users[1], 'updated', 'task', 3, tasks[2].title, 50);
  log(users[1], 'commented on', 'task', 3, tasks[2].title, 45);
  log(me, 'completed', 'task', 8, tasks[7].title, 30);
  var notifications = [
    { id: 3, kind: 'commented', taskId: 3, taskTitle: tasks[2].title, taskGone: false, actorId: 2, actorName: users[1].displayName, summary: '', createdAt: stamp(45), read: false },
    { id: 2, kind: 'dueToday', taskId: 12, taskTitle: tasks[11].title, taskGone: false, actorId: 0, actorName: '', summary: '', createdAt: stamp(240), read: false },
    { id: 1, kind: 'mentioned', taskId: 1, taskTitle: tasks[0].title, taskGone: false, actorId: 5, actorName: users[4].displayName, summary: '', createdAt: stamp(1500), read: true }
  ];
  var appName = 'Directive';

  // ---- helpers ----
  function byId(id) { return tasks.filter(function (t) { return t.id === id && !t.deleted; })[0]; }
  function isOverdue(t) { return t.status !== 'done' && t.dueDate && t.dueDate < TODAY; }
  function view(t) {
    var items = checklist.filter(function (c) { return c.taskId === t.id; });
    var out = {};
    for (var k in t) if (k !== 'deleted' && k !== 'deletedAt') out[k] = t[k];
    out.overdue = !!isOverdue(t);
    out.commentCount = comments.filter(function (c) { return c.taskId === t.id; }).length;
    out.checklistTotal = items.length;
    out.checklistDone = items.filter(function (c) { return c.done; }).length;
    return out;
  }
  function inScope(t, scope) {
    if (!scope || scope === 'all') return true;
    if (scope === 'mine') return t.assigneeId === me.id;
    return t.deptId === scope || t.deptId.indexOf(scope + '/') === 0;
  }
  function deptLabel(id) { var d = depts.filter(function (x) { return x.id === id; })[0]; return d ? d.name : ''; }
  var PRI = { High: 0, Medium: 1, Low: 2 };
  var SORTS = {
    created: function (a, b) { return a.id - b.id; },
    due: function (a, b) { return (a.dueDate ? 0 : 1) - (b.dueDate ? 0 : 1) || (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0) || a.id - b.id; },
    priority: function (a, b) { return PRI[a.priority] - PRI[b.priority] || SORTS.due(a, b); },
    updated: function (a, b) { return a.updatedAt < b.updatedAt ? 1 : -1; },
    title: function (a, b) { return a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1; }
  };
  function matches(t, q) {
    q = q.toLowerCase();
    if ((t.title + ' ' + t.assignee + ' ' + deptLabel(t.deptId)).toLowerCase().indexOf(q) !== -1) return {};
    if (t.description.toLowerCase().indexOf(q) !== -1) return { in: 'description', snippet: t.description.slice(0, 80) };
    var c = comments.filter(function (x) { return x.taskId === t.id && x.body.toLowerCase().indexOf(q) !== -1; })[0];
    if (c) return { in: 'comment', author: c.authorName, snippet: c.body };
    var ci = checklist.filter(function (x) { return x.taskId === t.id && x.body.toLowerCase().indexOf(q) !== -1; })[0];
    if (ci) return { in: 'checklist', snippet: ci.body };
    return null;
  }
  function listTasks(qs) {
    var scope = qs.get('scope') || 'all', q = (qs.get('q') || '').trim();
    var pri = qs.get('priority'), cal = qs.get('calendar'), who = qs.get('assignee'), status = qs.get('status');
    var from = qs.get('dueFrom'), to = qs.get('dueTo');
    var base = tasks.filter(function (t) {
      if (t.deleted || !inScope(t, scope)) return false;
      if (pri && pri !== 'all' && pri.split(',').indexOf(t.priority) === -1) return false;
      if (cal === 'shown' && !t.calendarVisible) return false;
      if (cal === 'hidden' && t.calendarVisible) return false;
      if (who === 'none' && t.assigneeId) return false;
      if (who && who !== 'none' && String(t.assigneeId) !== who) return false;
      if (from && (!t.dueDate || t.dueDate < from)) return false;
      if (to && (!t.dueDate || t.dueDate > to)) return false;
      if (q && !matches(t, q)) return false;
      return true;
    });
    var counts = { all: base.length, todo: 0, inprogress: 0, review: 0, done: 0, overdue: 0 };
    base.forEach(function (t) { counts[t.status]++; if (isOverdue(t)) counts.overdue++; });
    var list = base.filter(function (t) {
      if (!status || status === 'all') return true;
      return status.split(',').some(function (s) { return s === 'overdue' ? isOverdue(t) : t.status === s; });
    }).sort(SORTS[qs.get('sort')] || SORTS.created);
    var size = Math.min(100, Number(qs.get('pageSize')) || 50), pages = Math.max(1, Math.ceil(list.length / size));
    var page = Math.min(pages, Math.max(1, Number(qs.get('page')) || 1));
    return { tasks: list.slice((page - 1) * size, page * size).map(function (t) { var v = view(t); var m = q && matches(t, q); if (m && m.in) v.match = m; return v; }),
      page: page, pageSize: size, total: list.length, totalPages: pages, statusCounts: counts };
  }
  function summary() {
    var live = tasks.filter(function (t) { return !t.deleted; }), byDept = {};
    depts.forEach(function (d) { byDept[d.id] = live.filter(function (t) { return inScope(t, d.id); }).length; });
    return { all: live.length, mine: live.filter(function (t) { return t.assigneeId === me.id; }).length, trash: tasks.length - live.length, byDept: byDept };
  }
  function nextDue(due, rule) {
    var d = new Date(due + 'T00:00:00'), f = (/FREQ=(\w+)/.exec(rule) || [])[1], n = Number((/INTERVAL=(\d+)/.exec(rule) || [])[1] || 1);
    if (f === 'DAILY') d.setDate(d.getDate() + n); else if (f === 'WEEKLY') d.setDate(d.getDate() + 7 * n);
    else if (f === 'MONTHLY') d.setMonth(d.getMonth() + n); else if (f === 'YEARLY') d.setFullYear(d.getFullYear() + n);
    return iso(d);
  }
  function setStatus(t, status) {
    var was = t.status;
    t.status = status; t.updatedAt = stamp(0);
    log(me, status === 'done' ? 'completed' : (was === 'done' ? 'reopened' : 'updated'), 'task', t.id, t.title);
    if (status === 'done' && t.recurrence && t.dueDate) {
      var copy = JSON.parse(JSON.stringify(t));
      copy.id = nextId++; copy.status = 'todo'; copy.dueDate = nextDue(t.dueDate, t.recurrence);
      tasks.push(copy); t.recurrence = '';
      return copy.id;
    }
    return 0;
  }

  // ---- routes ----
  var routes = [];
  function on(method, pattern, fn) { routes.push([method, new RegExp('^' + pattern + '$'), fn]); }
  var ok = function (v) { return [200, v]; }, none = [204, null];
  function err(code, msg) { return [code, { error: msg }]; }

  on('GET', '/api/settings', function () { return ok({ appName: appName, setupRequired: false }); });
  on('PUT', '/api/settings', function (m, b) { appName = (b.appName || appName).trim(); return ok({ appName: appName }); });
  on('GET', '/api/me', function () { return ok(me); });
  on('PUT', '/api/me', function (m, b) { if (b.displayName) me.displayName = b.displayName.trim(); return ok(me); });
  on('POST', '/api/(login|register)', function () { return ok(me); });
  on('POST', '/api/logout', function () { return err(400, L('This is a demo - there is no signing out.', '데모라서 로그아웃은 할 수 없습니다.')); });
  on('GET', '/api/members', function () { return ok(users.map(function (u) { return { id: u.id, displayName: u.displayName, deptId: u.deptId }; })); });
  on('GET', '/api/users', function () { return ok(users.map(function (u) { var o = {}; for (var k in u) o[k] = u[k]; o.createdAt = stamp(50000); return o; })); });
  on('PUT', '/api/users/(\\d+)', function (m, b) { var u = users.filter(function (x) { return x.id === Number(m[1]); })[0]; for (var k in b) u[k] = b[k]; return none; });
  on('GET', '/api/departments', function () { return ok(depts); });
  on('POST', '/api/departments', function (m, b) {
    var id = (b.parentId ? b.parentId + '/' : '') + (b.name || 'dept').toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-');
    var d = { id: id, name: b.name, parentId: b.parentId || '', calendarList: '', tag: '', feedToken: 'demo' + nextId++, color: '' };
    depts.push(d); return [201, d];
  });
  on('PUT', '/api/departments/(.+)', function (m, b) { var d = depts.filter(function (x) { return x.id === m[1]; })[0]; if (!d) return err(404, 'no such department'); for (var k in b) d[k === 'tag' ? 'tag' : k] = b[k]; return none; });
  on('DELETE', '/api/departments/(.+)', function () { return err(409, L('Departments cannot be deleted in the demo.', '데모에서는 부서를 지울 수 없습니다.')); });

  on('GET', '/api/tasks', function (m, b, qs) { return ok(listTasks(qs)); });
  on('GET', '/api/tasks/summary', function () { return ok(summary()); });
  on('GET', '/api/tasks/today', function () {
    return ok(tasks.filter(function (t) { return !t.deleted && t.status !== 'done' && t.dueDate && t.dueDate <= TODAY; }).sort(SORTS.due).map(view));
  });
  on('GET', '/api/tasks/(\\d+)', function (m) { var t = byId(Number(m[1])); return t ? ok(view(t)) : err(404, 'no such task'); });
  on('POST', '/api/tasks', function (m, b) {
    if (!(b.title || '').trim()) return err(400, 'a title is required');
    var t = task(nextId++, b.title.trim(), b.deptId || '', b.assigneeId || 0, b.priority || 'Medium', b.dueDate || '', 'todo',
      { description: b.description || '', calendarVisible: !!b.calendarVisible, recurrence: b.recurrence || '', updatedAt: stamp(0) });
    if (!b.assigneeId) t.assignee = b.assignee || '';
    (b.checklist || []).forEach(function (body, i) { checklist.push({ id: nextId++, taskId: t.id, body: body, done: false, position: i }); });
    tasks.push(t); log(me, 'created', 'task', t.id, t.title);
    return [201, view(t)];
  });
  on('PUT', '/api/tasks/(\\d+)', function (m, b) {
    var t = byId(Number(m[1])); if (!t) return err(404, 'no such task');
    ['title', 'description', 'deptId', 'assignee', 'assigneeId', 'priority', 'dueDate', 'calendarVisible', 'recurrence'].forEach(function (k) { if (k in b) t[k] = b[k]; });
    if (b.status && b.status !== t.status) return ok({ nextId: setStatus(t, b.status) });
    t.updatedAt = stamp(0); log(me, 'updated', 'task', t.id, t.title);
    return ok(view(t));
  });
  on('PUT', '/api/tasks/(\\d+)/status', function (m, b) { var t = byId(Number(m[1])); return t ? ok({ nextId: setStatus(t, b.status) }) : err(404, 'no such task'); });
  on('DELETE', '/api/tasks/(\\d+)', function (m) { var t = byId(Number(m[1])); if (!t) return err(404, 'no such task'); t.deleted = true; t.deletedAt = stamp(0); log(me, 'moved to the trash', 'task', t.id, t.title); return none; });
  on('PUT', '/api/tasks/(\\d+)/icon', function (m, b) { var t = byId(Number(m[1])); if (b.emoji) t.icon = b.emoji; return none; });
  on('DELETE', '/api/tasks/(\\d+)/icon', function (m) { byId(Number(m[1])).icon = ''; return none; });

  on('GET', '/api/tasks/(\\d+)/checklist', function (m) { return ok(checklist.filter(function (c) { return c.taskId === Number(m[1]); }).sort(function (a, b) { return a.position - b.position; })); });
  on('POST', '/api/tasks/(\\d+)/checklist', function (m, b) { var c = { id: nextId++, taskId: Number(m[1]), body: b.body, done: false, position: 99 }; checklist.push(c); return [201, c]; });
  on('PUT', '/api/tasks/(\\d+)/checklist/order', function (m, b) { (b.ids || []).forEach(function (id, i) { checklist.forEach(function (c) { if (c.id === id) c.position = i; }); }); return none; });
  on('PUT', '/api/checklist/(\\d+)', function (m, b) { var c = checklist.filter(function (x) { return x.id === Number(m[1]); })[0]; for (var k in b) c[k] = b[k]; return ok(c); });
  on('DELETE', '/api/checklist/(\\d+)', function (m) { checklist = checklist.filter(function (x) { return x.id !== Number(m[1]); }); return none; });

  on('GET', '/api/tasks/(\\d+)/comments', function (m) { return ok(comments.filter(function (c) { return c.taskId === Number(m[1]); }).map(function (c) { var o = {}; for (var k in c) o[k] = c[k]; o.mine = c.authorId === me.id; return o; })); });
  on('POST', '/api/tasks/(\\d+)/comments', function (m, b) { var t = byId(Number(m[1])); var c = { id: nextId++, taskId: t.id, authorId: me.id, authorName: me.displayName, body: b.body, createdAt: stamp(0) }; comments.push(c); log(me, 'commented on', 'task', t.id, t.title); return [201, c]; });
  on('DELETE', '/api/comments/(\\d+)', function (m) { comments = comments.filter(function (x) { return x.id !== Number(m[1]); }); return none; });
  on('GET', '/api/tasks/(\\d+)/attachments', function () { return ok([]); });
  on('POST', '/api/tasks/(\\d+)/attachments', function () { return err(400, L('File uploads are turned off in the demo.', '데모에서는 파일을 올릴 수 없습니다.')); });

  on('GET', '/api/activity', function (m, b, qs) {
    var t = qs.get('task');
    var list = t ? activity.filter(function (a) { return a.subject === 'task' && a.subjectId === t; }) : activity;
    return ok(list.slice(0, Number(qs.get('limit')) || 50));
  });
  on('GET', '/api/notifications', function () { return ok({ items: notifications, unread: notifications.filter(function (n) { return !n.read; }).length }); });
  on('POST', '/api/notifications/read', function (m, b) { notifications.forEach(function (n) { if (!b.ids || b.ids.indexOf(n.id) !== -1) n.read = true; }); return none; });

  on('GET', '/api/trash', function () {
    return ok(tasks.filter(function (t) { return t.deleted; }).map(function (t) { var v = view(t); v.deletedAt = t.deletedAt; v.deletedByName = me.displayName; v.purgeAt = new Date(Date.now() + 10 * 864e5).toISOString(); v.canRestore = true; return v; }));
  });
  on('POST', '/api/trash/(\\d+)/restore', function (m) { tasks.forEach(function (t) { if (t.id === Number(m[1])) t.deleted = false; }); return none; });
  on('DELETE', '/api/trash/(\\d+)', function (m) { tasks = tasks.filter(function (t) { return t.id !== Number(m[1]); }); return none; });
  on('DELETE', '/api/trash', function () { tasks = tasks.filter(function (t) { return !t.deleted; }); return none; });

  on('GET', '/api/me/app-passwords', function () { return ok([]); });
  on('GET', '/api/reminders', function () { return ok({ enabled: true, time: '09:00', serverTime: new Date().toTimeString().slice(0, 5) }); });
  on('GET', '/api/backups', function () { return ok({ enabled: false, time: '03:00', keep: 14, files: [], serverTime: new Date().toTimeString().slice(0, 5) }); });
  // Everything else that would change the server is politely refused.
  on('(POST|PUT|DELETE)', '/api/.*', function () { return err(400, L('Not available in the demo.', '데모에서는 쓸 수 없는 기능입니다.')); });
  on('GET', '/api/.*', function () { return err(404, 'not found'); });

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = new URL(typeof input === 'string' ? input : input.url, location.href);
    var path = url.pathname.replace(/^.*?(\/api\/)/, '/api/');
    if (path.indexOf('/api/') !== 0) return realFetch(input, init);
    var method = ((init && init.method) || 'GET').toUpperCase();
    var body = {};
    try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (e) {}
    for (var i = 0; i < routes.length; i++) {
      var r = routes[i], m;
      if (!new RegExp('^(' + r[0] + ')$').test(method) || !(m = r[1].exec(path))) continue;
      var res = r[2](m, body, url.searchParams);
      var status = res[0];
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve(new Response(status === 204 ? null : JSON.stringify(res[1]), { status: status, headers: { 'Content-Type': 'application/json' } }));
        }, 60);
      });
    }
    return realFetch(input, init);
  };

  // No live updates without a server: a quiet stand-in for the event stream.
  window.EventSource = function () { this.close = function () {}; this.addEventListener = function () {}; };

  // Pictures (avatars, app icon) are not served; the app falls back to letters.
  // A small badge says what this page is.
  document.addEventListener('DOMContentLoaded', function () {
    var b = document.createElement('a');
    b.href = 'https://github.com/nveloper/Directive';
    b.textContent = L('Demo · sample data, resets on reload', '데모 · 샘플 데이터, 새로고침하면 초기화');
    b.className = 'demo-badge';
    b.setAttribute('style', 'position:fixed; left:12px; bottom:12px; z-index:1000; padding:6px 10px; border-radius:6px; font:500 12px/1.2 system-ui, sans-serif; color:#fff; background:rgba(20,20,22,.82); text-decoration:none;');
    // Centred at the bottom, clear of the sidebar, the + button and the detail
    // panel's comment box; it steps aside for the selection bar and toasts.
    var css = document.createElement('style');
    css.textContent = '.demo-badge { left: 50% !important; transform: translateX(-50%); white-space: nowrap; } body:has(.bulk-bar, .snackbar, .detail-overlay, .modal-overlay, .left-nav.open, .left-nav.anim-open, .right-panel.open, .right-panel.anim-open, .bell-panel, .dropdown-panel) .demo-badge { display: none; }';
    document.head.appendChild(css);
    document.body.appendChild(b);
  });
})();
