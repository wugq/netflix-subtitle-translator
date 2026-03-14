'use strict';

class TtmlParser {
  static get NS()       { return 'http://www.w3.org/ns/ttml'; }
  static get PARAM_NS() { return 'http://www.w3.org/ns/ttml#parameter'; }

  static parse(xmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'application/xml');
    const err = doc.querySelector('parsererror');
    if (err) throw new Error('XML parse error: ' + err.textContent.slice(0, 100));

    const tt = doc.getElementsByTagNameNS(TtmlParser.NS, 'tt')[0];
    const ttp = (ns, name) =>
      tt?.getAttributeNS(ns, name) || tt?.getAttribute(`ttp:${name}`) || tt?.getAttribute(name);

    const tickRate  = parseInt(ttp(TtmlParser.PARAM_NS, 'tickRate')  || '10000000', 10);
    const frameRate = parseFloat(ttp(TtmlParser.PARAM_NS, 'frameRate') || '30');
    const frameRateMultiplierRaw = ttp(TtmlParser.PARAM_NS, 'frameRateMultiplier') || '';

    let frameRateMultiplier = 1;
    if (frameRateMultiplierRaw) {
      const parts = frameRateMultiplierRaw.trim().split(/\s+/).map(Number);
      if (parts.length === 2 && parts[0] && parts[1]) frameRateMultiplier = parts[0] / parts[1];
    }

    const params = {
      tickRate,
      frameRate: frameRate * frameRateMultiplier,
      timeBase: ttp(TtmlParser.PARAM_NS, 'timeBase') || 'media',
    };

    const presentationTimeOffset = TtmlParser.parseTime(
      ttp(TtmlParser.PARAM_NS, 'presentationTimeOffset') || '0', params
    );

    function getAbsoluteOffset(el) {
      let offset = 0;
      let curr = el.parentElement;
      while (curr && curr !== tt) {
        const b = curr.getAttribute('begin');
        if (b) offset += TtmlParser.parseTime(b, params);
        curr = curr.parentElement;
      }
      return offset;
    }

    const ps = doc.getElementsByTagNameNS(TtmlParser.NS, 'p');
    const segments = [];
    let pIndex = 0;

    for (const p of ps) {
      const text = TtmlParser.nodeToText(p).trim();
      if (!text) continue;

      const beginAttr = p.getAttribute('begin');
      const endAttr   = p.getAttribute('end');
      const durAttr   = p.getAttribute('dur');
      if (!beginAttr && !endAttr && !durAttr) continue;

      const containerOffset = getAbsoluteOffset(p);
      let begin = beginAttr ? TtmlParser.parseTime(beginAttr, params) + containerOffset : containerOffset;
      let end   = endAttr   ? TtmlParser.parseTime(endAttr,   params) + containerOffset : null;

      if (end === null && durAttr) {
        end = begin + TtmlParser.parseTime(durAttr, params);
      }

      if (begin === null || end === null) continue;

      begin -= presentationTimeOffset;
      end   -= presentationTimeOffset;

      const idAttr = p.getAttribute('xml:id') || p.getAttribute('id');
      const key = `${idAttr || 'p' + pIndex}|${beginAttr || ''}|${endAttr || ''}|${durAttr || ''}`;

      segments.push({ id: idAttr || null, key, begin, end, text, seq: pIndex });
      pIndex++;
    }

    segments.sort((a, b) => a.begin - b.begin);
    return segments;
  }

  static parseTime(t, params) {
    if (!t) return 0;
    const tickRate  = params?.tickRate  || 10000000;
    const frameRate = params?.frameRate || 30;

    const m = t.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];

    const m2 = t.match(/^(\d+):(\d+(?:\.\d+)?)$/);
    if (m2) return +m2[1] * 60 + +m2[2];

    const m3 = t.match(/^(\d+):(\d+):(\d+):(\d+)$/);
    if (m3) return +m3[1] * 3600 + +m3[2] * 60 + +m3[3] + (+m3[4] / frameRate);

    const unit = t.match(/^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/);
    if (unit) {
      const v = parseFloat(unit[1]);
      const u = unit[2];
      if (u === 'h')  return v * 3600;
      if (u === 'm')  return v * 60;
      if (u === 's')  return v;
      if (u === 'ms') return v / 1000;
      if (u === 'f')  return v / frameRate;
      if (u === 't')  return v / tickRate;
    }

    return parseFloat(t) / tickRate;
  }

  static nodeToText(node) {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.nodeValue;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.localName === 'br') out += '\n';
        else out += TtmlParser.nodeToText(child);
      }
    }
    return out;
  }
}
