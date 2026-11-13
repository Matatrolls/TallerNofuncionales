const fs = require('fs');

function parseCsvLine(line) {
  const campos = [];
  let actual = '';
  let entreComillas = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (entreComillas) {
      if (c === '"' && line[i + 1] === '"') {
        actual += '"';
        i++;
      } else if (c === '"') {
        entreComillas = false;
      } else {
        actual += c;
      }
    } else if (c === '"') {
      entreComillas = true;
    } else if (c === ',') {
      campos.push(actual);
      actual = '';
    } else {
      actual += c;
    }
  }
  campos.push(actual);
  return campos;
}

function leerJtl(path) {
  const contenido = fs.readFileSync(path, 'utf8');
  const lineas = contenido.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lineas.length === 0) {
    return [];
  }

  const cabecera = parseCsvLine(lineas[0]);
  const idx = (nombre) => cabecera.indexOf(nombre);

  const iLabel = idx('label');
  const iElapsed = idx('elapsed');
  const iSuccess = idx('success');
  const iCode = idx('responseCode');
  const iMessage = idx('responseMessage');
  const iFailure = idx('failureMessage');

  const filas = [];
  for (let n = 1; n < lineas.length; n++) {
    const campos = parseCsvLine(lineas[n]);
    filas.push({
      label: iLabel >= 0 ? campos[iLabel] : '?',
      elapsed: iElapsed >= 0 ? Number(campos[iElapsed]) || 0 : 0,
      success: iSuccess >= 0 ? String(campos[iSuccess]).trim().toLowerCase() === 'true' : true,
      responseCode: iCode >= 0 ? campos[iCode] : '',
      responseMessage: iMessage >= 0 ? campos[iMessage] : '',
      failureMessage: iFailure >= 0 ? campos[iFailure] : '',
    });
  }
  return filas;
}

async function asegurarEtiquetas(github, context, nombres) {
  for (const nombre of nombres) {
    try {
      await github.rest.issues.getLabel({
        owner: context.repo.owner,
        repo: context.repo.repo,
        name: nombre,
      });
    } catch (err) {
      if (err.status !== 404) {
        throw err;
      }
      await github.rest.issues.createLabel({
        owner: context.repo.owner,
        repo: context.repo.repo,
        name: nombre,
        color: nombre === 'ci-success' ? '0e8a16' : 'ededed',
        description: 'Etiqueta gestionada automáticamente por el flujo de CI',
      });
    }
  }
}

module.exports = async ({ github, context }) => {
  const path = process.env.JMETER_JTL || 'results.jtl';

  if (!fs.existsSync(path)) {
    console.log('No se encontró archivo de resultados de JMeter.');
    return;
  }

  let filas;
  try {
    filas = leerJtl(path);
  } catch (err) {
    console.log('No se pudo parsear el archivo de resultados:', err);
    return;
  }

  if (filas.length === 0) {
    console.log('El archivo de resultados está vacío.');
    return;
  }

  const resumen = new Map();
  for (const fila of filas) {
    if (!resumen.has(fila.label)) {
      resumen.set(fila.label, {
        label: fila.label,
        total: 0,
        fallos: 0,
        ms: 0,
        codigos: new Set(),
        errores: [],
      });
    }
    const r = resumen.get(fila.label);
    r.total += 1;
    r.ms += fila.elapsed;
    if (fila.responseCode) {
      r.codigos.add(fila.responseCode);
    }
    if (!fila.success) {
      r.fallos += 1;
      if (fila.failureMessage || fila.responseMessage) {
        r.errores.push(fila.failureMessage || fila.responseMessage);
      }
    }
  }

  const exitosos = [...resumen.values()].filter((r) => r.fallos === 0);
  const conFallos = [...resumen.values()].filter((r) => r.fallos > 0);

  console.log(
    `Se encontraron ${exitosos.length} samplers exitosos y ${conFallos.length} con fallos.`
  );

  for (const r of conFallos) {
    console.log(`Sampler con fallos (no se reporta como issue): ${r.label} (${r.fallos}/${r.total})`);
  }

  if (exitosos.length === 0) {
    console.log('No hay samplers exitosos que reportar.');
    return;
  }

  await asegurarEtiquetas(github, context, ['automated', 'ci-success']);

  const issuesExistentes = await github.rest.issues.listForRepo({
    owner: context.repo.owner,
    repo: context.repo.repo,
    state: 'open',
    labels: 'automated',
  });

  const prom = (r) => (r.total ? Math.round(r.ms / r.total) : 0);
  const codigos = (r) => [...r.codigos].join(', ') || 'N/A';

  for (const ex of exitosos) {
    const issueTitle = `[Éxito CI]: ${ex.label}`;
    const yaExiste = issuesExistentes.data.find((i) => i.title === issueTitle);

    const issueBody = [
      '### ✅ Sampler ejecutado correctamente en JMeter CI',
      `- **Sampler:** \`${ex.label}\``,
      `- **Muestras:** \`${ex.total}\``,
      `- **Duración promedio:** \`${prom(ex)}ms\``,
      `- **Códigos de respuesta:** \`${codigos(ex)}\``,
      `- **Commit:** \`${context.sha}\``,
      `- **Ejecución:** [Ver workflow run](${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId})`,
      '',
      '> *Este issue fue generado automáticamente por el flujo de CI para registrar el resultado exitoso en el proyecto.*',
    ].join('\n');

    if (yaExiste) {
      console.log(`Comentando en issue exitoso existente #${yaExiste.number}: ${issueTitle}`);
      await github.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: yaExiste.number,
        body: `✅ Sampler superado nuevamente con éxito en la ejecución del commit \`${context.sha}\` (${ex.total} muestras, promedio \`${prom(ex)}ms\`).`,
      });
    } else {
      console.log(`Creando nuevo issue de éxito: ${issueTitle}`);
      await github.rest.issues.create({
        owner: context.repo.owner,
        repo: context.repo.repo,
        title: issueTitle,
        body: issueBody,
        labels: ['ci-success', 'automated'],
      });
    }
  }
};
