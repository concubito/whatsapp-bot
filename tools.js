const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const herramientasGemini = {
    functionDeclarations: [
        {
            name: "ejecutar_comando_linux",
            description: "Ejecuta un comando de terminal/bash en el sistema CachyOS del usuario y devuelve el resultado. Útil para leer archivos, listar directorios, gestionar el sistema o usar otras herramientas CLI.",
            parameters: {
                type: "OBJECT",
                properties: {
                    comando: {
                        type: "STRING",
                        description: "El comando exacto de bash a ejecutar (ej. 'ls -la', 'cat /tmp/archivo.txt', 'uptime')"
                    }
                },
                required: ["comando"]
            }
        }
    ]
};

async function ejecutarComandoLinux(comando) {
    try {
        console.log(`[Sistema] Ejecutando: ${comando}`);
        const { stdout, stderr } = await execAsync(comando);
        
        if (stderr) {
            console.warn(`[Sistema] Advertencia: ${stderr}`);
        }
        
        const salida = stdout.trim() || stderr.trim() || "Comando ejecutado exitosamente sin salida de texto.";
        return salida.substring(0, 2000); 
    } catch (error) {
        console.error(`[Sistema] Error: ${error.message}`);
        return `Error al ejecutar el comando: ${error.message}`;
    }
}

module.exports = {
    herramientasGemini,
    ejecutarComandoLinux
};
