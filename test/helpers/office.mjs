// Minimal but genuine office documents, built in memory for the extraction
// tests: real ZIP containers holding the XML parts Word, Excel, PowerPoint and
// LibreOffice write, so the server reads them exactly as it would a real file.

import { PassThrough } from 'node:stream'
import { writeZip } from '../../server/zip.mjs'

export async function zipOf(files) {
  const out = new PassThrough()
  const chunks = []
  out.on('data', (chunk) => chunks.push(chunk))
  async function* entries() {
    for (const [path, text] of Object.entries(files)) {
      yield { path, content: Buffer.from(text, 'utf8'), modified: new Date(2026, 8, 21) }
    }
  }
  await writeZip(out, entries())
  out.end()
  return Buffer.concat(chunks)
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

export function docx() {
  return zipOf({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Market sizing</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">Total addressable market is </w:t></w:r><w:r><w:t>£4.2bn &amp; growing.</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>First bullet</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Share</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>EMEA</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>41%</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      </w:body></w:document>`,
  })
}

export function xlsx() {
  return zipOf({
    'xl/workbook.xml':
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Revenue" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; caveats" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml':
      '<sst><si><t>Quarter</t></si><si><t>Revenue</t></si><si><r><t>Q3 </t></r><r><t>2026</t></r></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"/><c r="C2"><f>SUM(1,2)</f><v>1250000</v></c><c r="D2" t="b"><v>1</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Unaudited figures</t></is></c></row></sheetData></worksheet>',
  })
}

const P =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

export function pptx() {
  return zipOf({
    'ppt/slides/slide2.xml': `<p:sld ${P}><a:p><a:r><a:t>Next steps</a:t></a:r></a:p></p:sld>`,
    'ppt/slides/slide1.xml':
      `<p:sld ${P}><a:p><a:r><a:t>Quarterly </a:t></a:r><a:r><a:t lang="en-GB">review</a:t></a:r></a:p><a:p><a:r><a:t>Churn fell to 2%</a:t></a:r></a:p></p:sld>`,
  })
}

export function odt() {
  return zipOf({
    'content.xml':
      '<office:document-content><office:body><office:text><text:h>Minutes</text:h><text:p>Agreed<text:s text:c="2"/>budget</text:p></office:text></office:body></office:document-content>',
  })
}
