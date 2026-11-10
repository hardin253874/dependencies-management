/**
 * CVSS 3.x base score from the vector (v2 Stage 5a.1).
 *
 * Expected scores: FIRST "CVSS v3.1 Examples" document,
 * https://www.first.org/cvss/v3.1/examples (checked 2026-11-10); the CVE id
 * names the example. Equations and weights: https://www.first.org/cvss/v3.1/specification-document.
 *
 * 3.0 vs 3.1 roundup: an exhaustive check over all 2,592 base vectors found
 * no vector whose score differs between the 3.0 roundup (ceil to one
 * decimal) and the 3.1 integer Roundup with these equations (recorded in the
 * Stage 5a dev notes). So the two roundups are tested directly, on the
 * float-error input that v3.1 Appendix A names.
 */
import { describe, it, expect } from 'vitest';
import { cvss3BaseScore, roundup30, roundup31 } from '@/lib/scanners/cvss';
import { deriveSeverity } from '@/lib/scanners/cve';

const EXAMPLES: Array<[string, string, number]> = [
  ['CVE-2014-6271 Shellshock', 'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8],
  ['CVE-2017-5942 WP Mail XSS', 'AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', 6.1],
  ['CVE-2015-1098 iWork DoS', 'AV:L/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H', 7.8],
  ['CVE-2013-0375 MySQL SQLi (S:C, PR:L)', 'AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:N', 6.4],
  ['CVE-2012-1516 VMware escape (S:C, PR:L)', 'AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H', 9.9],
  ['CVE-2016-5729 ThinkPwn (S:C, PR:H)', 'AV:L/AC:L/PR:H/UI:N/S:C/C:H/I:H/A:H', 8.2],
  ['CVE-2014-3566 POODLE', 'AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N', 3.1],
  ['CVE-2009-0783 Tomcat XML', 'AV:L/AC:L/PR:H/UI:N/S:U/C:L/I:L/A:L', 4.2],
  ['CVE-2012-0384 Cisco IOS', 'AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H', 7.2],
  ['CVE-2014-0160 Heartbleed', 'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N', 7.5],
  ['CVE-2008-1447 Kaminsky', 'AV:N/AC:H/PR:N/UI:N/S:C/C:N/I:H/A:N', 6.8],
  ['CVE-2014-2005 Sophos', 'AV:P/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 6.8],
  ['CVE-2013-6014 Juniper', 'AV:A/AC:L/PR:N/UI:N/S:C/C:H/I:N/A:H', 9.3],
  ['CVE-2019-7551 Cantemo', 'AV:N/AC:L/PR:L/UI:R/S:C/C:H/I:H/A:H', 9.0],
  ['CVE-2014-2019 iOS', 'AV:P/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:N', 4.6],
  ['CVE-2012-5376 Chrome sandbox', 'AV:N/AC:L/PR:N/UI:R/S:C/C:H/I:H/A:H', 9.6],
  ['CVE-2016-5558 Oracle Outside In', 'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:L/A:L', 8.6],
  ['CVE-2015-2890 flash lock', 'AV:L/AC:L/PR:H/UI:N/S:U/C:N/I:H/A:H', 6.0],
  ['CVE-2018-3652 Intel DCI', 'AV:P/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H', 7.6]
];

describe('cvss3BaseScore — FIRST v3.1 examples (5a.1)', () => {
  it.each(EXAMPLES)('%s', (_name, base, expected) => {
    expect(cvss3BaseScore(`CVSS:3.1/${base}`)).toBe(expected);
  });

  it('scores 3.0 vectors with the same equations', () => {
    expect(cvss3BaseScore('CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
    expect(cvss3BaseScore('CVSS:3.0/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N')).toBe(6.1);
  });

  it('all-None impact → 0.0 (both scopes)', () => {
    expect(cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N')).toBe(0);
    expect(cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:N/I:N/A:N')).toBe(0);
  });

  it('ignores temporal and environmental metrics (base score only)', () => {
    expect(cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:U/RL:O/RC:C/CR:H/MAV:L')).toBe(9.8);
  });

  it('metric order does not matter', () => {
    expect(cvss3BaseScore('CVSS:3.1/A:H/I:H/C:H/S:U/UI:N/PR:N/AC:L/AV:N')).toBe(9.8);
  });
});

describe('cvss3BaseScore — malformed → null (5a.1)', () => {
  it.each([
    ['missing metric (A)', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H'],
    ['unknown value', 'CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'],
    ['unknown metric', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/ZZ:H'],
    ['invalid temporal value', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:Z'],
    ['duplicate metric', 'CVSS:3.1/AV:N/AV:L/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'],
    ['CVSS v2 string', 'AV:N/AC:L/Au:N/C:P/I:P/A:P'],
    ['CVSS v4 string', 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'],
    ['unknown 3.x minor', 'CVSS:3.2/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'],
    ['empty segment', 'CVSS:3.1/AV:N//AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'],
    ['empty string', '']
  ])('%s', (_name, vector) => {
    expect(cvss3BaseScore(vector)).toBeNull();
  });
});

describe('roundup (5a.1)', () => {
  it('3.1 Roundup avoids the float error the spec names; the 3.0 ceil does not', () => {
    const x = 0.1 + 0.2; // 0.30000000000000004
    expect(roundup31(x)).toBe(0.3);
    expect(roundup30(x)).toBe(0.4);
    expect(roundup31(4.02)).toBe(4.1);
    expect(roundup31(4.0)).toBe(4.0);
  });
});

describe('deriveSeverity with only a CVSS_V3 vector (5a.1)', () => {
  const v = (score: string) => ({ id: 'GHSA-test', severity: [{ type: 'CVSS_V3', score }] });

  it('maps the computed base score to the band (always unknown before 5a.1)', () => {
    expect(deriveSeverity(v('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'))).toBe('critical');
    expect(deriveSeverity(v('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N'))).toBe('high');
    expect(deriveSeverity(v('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N'))).toBe('medium');
    expect(deriveSeverity(v('CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N'))).toBe('low');
    expect(deriveSeverity(v('CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'))).toBe('critical');
  });

  it('0.0 and malformed vectors stay unknown; a plain number keeps working', () => {
    expect(deriveSeverity(v('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N'))).toBe('unknown');
    expect(deriveSeverity(v('CVSS:3.1/AV:N'))).toBe('unknown');
    expect(deriveSeverity(v('7.5'))).toBe('high');
  });

  it('database_specific.severity still wins over the vector', () => {
    expect(deriveSeverity({ ...v('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), database_specific: { severity: 'LOW' } })).toBe('low');
  });
});
