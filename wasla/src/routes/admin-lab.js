import { LAB_LISTS, MAX_ROOT_WORDS, MIN_ROOT_WORDS, RIDDLE_DECOYS, ROOT_LETTERS } from '../lab.js';

export const LAB_LABELS = Object.freeze({
  roots: {
    title: 'جِذر',
    note: 'جذر في كل سطر: الجذر، ثم نقطتان، ثم كل كلمة تقبلها الجولة.',
    hint: `الجذر ${ROOT_LETTERS} حروف، ومن ${MIN_ROOT_WORDS} إلى ${MAX_ROOT_WORDS} كلمة، مفصولة بمسافات أو فواصل. حروف المفاتيح تُبنى من الكلمات نفسها، فلا تكون كلمة غير قابلة للتهجئة.`,
    example: 'كتب: كتب كتاب كاتب كتابة مكتب مكتبة',
  },
  riddles: {
    title: 'قوافي',
    note: 'بيت أو مثل في كل سطر، وفيه ــــ مكان الفراغ. تلعبه «قوافي» و«اكشف المثل».',
    hint: `أربعة أجزاء مفصولة بـ | : النص | الجواب | ${RIDDLE_DECOYS} بدائل مفصولة بفواصل | المصدر. ويمكن جزء خامس: إيموجي تظهر فوق لوح «اكشف المثل». السطر بلا ــــ يعني أن الفراغ في آخره.`,
    example: 'الصبر مفتاح ــــ | الفرج | الرزق، النجاح، القلوب | مثل سائر | 😑⏳🔑',
  },
});

/**
 * The lab games' content, written here instead of inside the app.
 *
 * Same shape as the daily games' word lists: plain text, checked line by line,
 * and nothing is saved while a line is broken.
 */
export function registerLab(router, { lab }) {
  const render = (res, extra = {}) => res.render('lab', {
    title: 'ألعاب المختبر',
    labels: LAB_LABELS,
    lists: lab.lists().map((list) => ({ ...list, ...extra.drafts?.[list.name] ? { text: extra.drafts[list.name] } : {} })),
    problems: extra.problems ?? {},
    ...extra.flash ? { flash: extra.flash } : {},
  });

  router.get('/lab', (_req, res) => render(res));

  router.post('/lab/:name', (req, res) => {
    const { name } = req.params;
    if (!LAB_LISTS.includes(name)) return res.redirect('/admin/lab');
    const text = String(req.body.text ?? '');
    const result = lab.saveList(name, text);
    if (result.error) {
      return render(res, {
        drafts: { [name]: text },
        problems: { [name]: result.problems ?? [] },
        flash: { type: 'danger', message: `${LAB_LABELS[name].title}: ${result.error}` },
      });
    }
    req.flash('success', `${LAB_LABELS[name].title}: حُفظت ${result.count} مدخلاً. التطبيق يأخذها عند التشغيل القادم.`);
    res.redirect(`/admin/lab#${name}`);
  });

  router.post('/lab/:name/reset', (req, res) => {
    const { name } = req.params;
    if (LAB_LISTS.includes(name) && lab.resetList(name)) {
      req.flash('success', `${LAB_LABELS[name].title}: عادت القائمة المدمجة.`);
    }
    res.redirect(`/admin/lab#${name}`);
  });
}
