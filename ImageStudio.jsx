import React, { useState, useCallback, useMemo } from 'react';
import { CloudUpload, Zap, RotateCw, Download, Image, Settings, Trash2, ChevronLeft, ChevronRight, Wand2, Star, MessageSquare } from 'lucide-react';

// --- CONFIGURAÇÃO DA API GEMINI ---
// Endpoint para Geração de Imagem (Image-to-Image)
const IMAGE_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent"; 
// Endpoint para Geração de Texto e Multimodal (Prompt Enhancement, Captioning e Background Suggestion)
const TEXT_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent"; 
const API_KEY = ""; // A chave API será injetada automaticamente.

// Parâmetros para simular a geração
const DEFAULT_PARAMS = {
    steps: 50,
    cfgScale: 7.0,
    seed: 42,
    candidateCount: 3, // Número TOTAL de variações a gerar (iterativamente)
};

// --- INSTRUÇÃO DE SISTEMA PARA PRESERVAÇÃO DE IDENTIDADE (Image-to-Image) ---
const SYSTEM_INSTRUCTION = "Act as an expert AI photorealism and identity preservation generator. Your EXTREME AND ABSOLUTE PRIMARY TASK is to preserve the face, identity, and likeness of the person from the reference image in all outputs, regardless of the prompt content. You must ensure the person's face (head and neck) is strictly maintained and recognizable in EVERY generated image. For each variation, adapt the setting, lighting, clothing, body posture, and camera angle as requested by the user prompt, while KEEPING THE PERSON AS THE CENTRAL SUBJECT. The output image MUST contain the full face of the reference person. Do not generate generic images or images where the person's identity is compromised. IMPORTANT: Ensure that the generated image is visually distinct from the reference input image, particularly in the background, clothing, and overall composition, to prevent image recitation.";

// --- FUNÇÕES DE UTENSÍLIO ---

// Função utilitária para retry com backoff exponencial
const fetchWithRetry = async (url, options, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if (response.status === 429 && i < retries - 1) { 
                const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
                console.warn(`Taxa limite atingida. Tentando novamente em ${Math.ceil(delay / 1000)}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`Erro na API: ${response.status} - ${errorBody}`);
            }
            return response;
        } catch (error) {
            if (i === retries - 1) throw error;
            console.error(`Erro na tentativa ${i + 1}:`, error);
        }
    }
};

// Função utilitária para converter File para Base64
const fileToBase64 = (file) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => {
            const base64String = reader.result.split(',')[1];
            resolve(base64String);
        };
        reader.onerror = (error) => reject(error);
    });
};

// --- COMPONENTE PRINCIPAL ---

const App = () => {
    const [mode, setMode] = useState('generate'); // 'generate' (geração) ou 'restore' (restauração)
    const [prompt, setPrompt] = useState('');
    const [referenceImage, setReferenceImage] = useState(null); // File object
    const [imagePreviewUrl, setImagePreviewUrl] = useState(null); // URL for display
    const [generatedImages, setGeneratedImages] = useState([]); // Array de URLs Base64 dos resultados
    const [currentImageIndex, setCurrentImageIndex] = useState(0); // Para navegação
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [successMessage, setSuccessMessage] = useState(null); // Mensagens de sucesso de LLM/UX
    const [processingTime, setProcessingTime] = useState(0);
    const [currentGeneratingIndex, setCurrentGeneratingIndex] = useState(0); // Para UI do carregamento iterativo
    
    // Estados para as funcionalidades LLM
    const [isEnhancing, setIsEnhancing] = useState(false); 
    const [generatedCaptions, setGeneratedCaptions] = useState(null); 
    const [isCaptioning, setIsCaptioning] = useState(false); 
    
    // NOVOS ESTADOS para a Sugestão de Fundo
    const [suggestedBackgrounds, setSuggestedBackgrounds] = useState(null); 
    const [isSuggesting, setIsSuggesting] = useState(false); 

    // Estado para parâmetros avançados
    const [advancedParams, setAdvancedParams] = useState(DEFAULT_PARAMS);
    const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);

    // Schema JSON para saída de legendas estruturadas (Multimodal)
    const CAPTION_SCHEMA = useMemo(() => ({
        type: "OBJECT",
        properties: {
            Inspiradora: { type: "STRING", description: "Uma legenda inspiradora relacionada com o tema da imagem." },
            Engraçada: { type: "STRING", description: "Uma legenda espirituosa ou humorística." },
            Misteriosa: { type: "STRING", description: "Uma legenda que cria suspense ou intriga." },
            Hashtags: { type: "STRING", description: "Uma lista de 5 a 10 hashtags relevantes e populares separadas por espaços." },
        },
        propertyOrdering: ["Inspiradora", "Engraçada", "Misteriosa", "Hashtags"]
    }), []);


    // Prompt Otimizado (UX 2.2)
    const optimizedPrompt = useMemo(() => {
        if (mode === 'generate') {
            if (!prompt) return "N/A";
            // Adiciona uma instrução base de alta qualidade
            return `${prompt}, imagem de alta resolução, fotorrealista, iluminação dramática, 8k, obra-prima digital.`;
        } else { // mode === 'restore'
            return `Restaure e aprimore esta foto. Corrija quaisquer danos, melhore a nitidez, o contraste e as cores. Aumente a resolução para a máxima qualidade possível.`;
        }
    }, [prompt, mode]);


    // Manipulador de Upload de Imagem
    const handleImageUpload = useCallback((event) => {
        const file = event.target.files[0];
        if (file) {
            setReferenceImage(file);
            const reader = new FileReader();
            reader.onloadend = () => {
                setImagePreviewUrl(reader.result);
            };
            reader.readAsDataURL(file);
            // Limpa dados de LLM ao carregar nova imagem
            setSuggestedBackgrounds(null);
            setGeneratedCaptions(null);
            setGeneratedImages([]);
        }
    }, []);

    // --- FUNÇÃO LLM 1: Otimizador de Prompt (Text Generation) ---
    const handlePromptEnhance = useCallback(async () => {
        if (!prompt) {
            setError("Por favor, insira um prompt inicial para otimizar.");
            setSuccessMessage(null); 
            return;
        }

        setIsEnhancing(true);
        setError(null);
        setSuccessMessage(null);

        try {
            const systemPrompt = "You are an expert prompt engineer for photorealistic image generation. Your task is to take a short, simple user prompt and expand it into a detailed, creative, and highly descriptive prompt for a generative AI model, ensuring it includes elements like lighting, style, camera angle, and artistic quality. Output only the enhanced prompt text, without any introductory or concluding remarks.";

            const userQuery = `Expand this prompt into a detailed, high-quality, single-paragraph description suitable for image-to-image generation: "${prompt}"`;
            
            const payload = {
                contents: [{ parts: [{ text: userQuery }] }],
                systemInstruction: {
                    parts: [{ text: systemPrompt }]
                },
            };

            const response = await fetchWithRetry(`${TEXT_API_URL}?key=${API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            const enhancedText = result.candidates?.[0]?.content?.parts?.[0]?.text;

            if (enhancedText) {
                const cleanPrompt = enhancedText.replace(/^["']|["']$/g, '').trim(); 
                setPrompt(cleanPrompt);
                setSuccessMessage("Prompt otimizado com sucesso! Pronto para gerar.");
            } else {
                setError("Falha ao otimizar o prompt. Tente novamente.");
            }

        } catch (err) {
            console.error("Erro na otimização do prompt:", err);
            setError(`Erro ao contactar o LLM para otimização: ${err.message}`);
        } finally {
            setIsEnhancing(false);
        }
    }, [prompt]);

    // --- FUNÇÃO LLM 2: Gerador de Legendas (Multimodal Analysis + Text Generation) ---
    const handleCaptionGenerate = useCallback(async () => {
        if (!generatedImages.length || !referenceImage) {
            setError("Gere uma imagem primeiro e certifique-se de que a imagem de referência está carregada.");
            setSuccessMessage(null);
            return;
        }

        setIsCaptioning(true);
        setError(null);
        setSuccessMessage(null);
        setGeneratedCaptions(null);

        try {
            const systemPrompt = "You are a social media manager specializing in visual content. Your task is to analyze the provided image (the reference person) and the user's creative prompt to generate compelling, short social media captions and a set of relevant hashtags. The captions should reflect the style and theme requested in the prompt. Output the response STRICTLY as a JSON object following the provided schema.";
            
            const analysisPrompt = `Analyze the person in the image and the following creative description/goal: "${optimizedPrompt}". Generate captions (inspiring, funny, mysterious) and a list of 5-10 trending hashtags based on this combination.`;
            
            const base64ImageData = await fileToBase64(referenceImage);
            
            const payload = {
                contents: [{
                    role: "user",
                    parts: [
                        { text: analysisPrompt },
                        {
                            inlineData: {
                                mimeType: referenceImage.type,
                                data: base64ImageData
                            }
                        }
                    ]
                }],
                systemInstruction: { parts: [{ text: systemPrompt }] },
                generationConfig: {
                    responseMimeType: "application/json",
                    responseSchema: CAPTION_SCHEMA
                },
            };

            const response = await fetchWithRetry(`${TEXT_API_URL}?key=${API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
            
            if (jsonText) {
                const cleanJsonText = jsonText.replace(/^```json\s*|```\s*$/g, '').trim();
                const parsedCaptions = JSON.parse(cleanJsonText);
                setGeneratedCaptions(parsedCaptions);
                setSuccessMessage("Legendas geradas com sucesso!");
            } else {
                setError("Falha ao gerar legendas. Resposta do LLM inválida.");
            }

        } catch (err) {
            console.error("Erro na geração de legendas:", err);
            setError(`Erro ao gerar legendas: ${err.message}`);
        } finally {
            setIsCaptioning(false);
        }
    }, [generatedImages.length, optimizedPrompt, referenceImage, CAPTION_SCHEMA]);

    // --- NOVA FUNÇÃO LLM 3: Gerador de Sugestões de Fundo (Multimodal Analysis) ---
    const handleBackgroundSuggestion = useCallback(async () => {
        if (!referenceImage) {
            setError("Por favor, carregue uma imagem de referência primeiro para que a IA possa analisá-la.");
            setSuccessMessage(null);
            return;
        }

        setIsSuggesting(true);
        setError(null);
        setSuccessMessage(null);
        setSuggestedBackgrounds(null);

        try {
            const systemPrompt = "You are a visual stylist and background expert. Analyze the person's clothing, style, pose, and color palette in the image. Based on this analysis, generate 5 distinct, high-detail background scenes suitable for image generation prompts. The suggestions should include a mix of contrasting (e.g., modern person in ancient setting) and complementary (e.g., formal person in a luxurious setting) environments. Output ONLY a numbered list of the 5 suggestions, without any introductory or concluding text.";
            
            const analysisPrompt = "Analyze this person and suggest 5 photorealistic background prompts.";
            
            const base64ImageData = await fileToBase64(referenceImage);
            
            const payload = {
                contents: [{
                    role: "user",
                    parts: [
                        { text: analysisPrompt },
                        {
                            inlineData: {
                                mimeType: referenceImage.type,
                                data: base64ImageData
                            }
                        }
                    ]
                }],
                systemInstruction: { parts: [{ text: systemPrompt }] },
            };

            const response = await fetchWithRetry(`${TEXT_API_URL}?key=${API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            const suggestionsText = result.candidates?.[0]?.content?.parts?.[0]?.text;

            if (suggestionsText) {
                // Converte a lista numerada em um array de strings
                const suggestionsArray = suggestionsText.split('\n')
                    .map(line => line.replace(/^\d+\.\s*/, '').trim())
                    .filter(line => line.length > 0);
                    
                setSuggestedBackgrounds(suggestionsArray);
                setSuccessMessage("Sugestões de fundo geradas com sucesso. Use-as no seu prompt!");
            } else {
                setError("Falha ao gerar sugestões de fundo. Resposta do LLM inválida.");
            }

        } catch (err) {
            console.error("Erro na sugestão de fundo:", err);
            setError(`Erro ao gerar sugestões de fundo: ${err.message}`);
        } finally {
            setIsSuggesting(false);
        }
    }, [referenceImage]);


    // Manipulador de Geração de Imagem - AGORA ITERATIVO E RESILIENTE
    const handleGenerate = useCallback(async () => {
        // Validação
        if (mode === 'generate' && (!prompt || !referenceImage)) {
            setError("Por favor, forneça um prompt de texto e uma imagem de referência.");
            setSuccessMessage(null);
            return;
        }
        if (mode === 'restore' && !referenceImage) {
            setError("Por favor, envie uma foto para ser restaurada.");
            setSuccessMessage(null);
            return;
        }

        setLoading(true);
        setError(null); 
        setSuccessMessage(null); 
        setGeneratedImages([]); 
        setGeneratedCaptions(null); 
        setSuggestedBackgrounds(null); // Limpa sugestões
        setCurrentImageIndex(0);
        setCurrentGeneratingIndex(0);
        setProcessingTime(0);
        const startTime = Date.now();

        try {
            const finalPromptBase = optimizedPrompt;
            const totalVariations = advancedParams.candidateCount;
            const newGeneratedImages = [];
            let attemptCount = 0; 

            // 1. Lê a imagem em Base64 UMA VEZ antes do loop
            const base64ImageData = await fileToBase64(referenceImage);

            // Loop while para garantir que geramos o número total de variações bem-sucedidas
            while (newGeneratedImages.length < totalVariations && attemptCount < totalVariations * 2) { // Adiciona um limite de tentativas para evitar loops infinitos
                attemptCount++;
                const currentImageNumber = newGeneratedImages.length + 1; 

                setCurrentGeneratingIndex(currentImageNumber); // Atualiza o índice de carregamento

                // 2. Constrói o User Query Iterativo (para forçar variação e incluir o número da tentativa)
                const querySuffix = ` Crie a Variação N.º ${currentImageNumber} do pedido. Altere a pose, ângulo de câmara, iluminação, ou vestuário ligeiramente em relação às variações anteriores. (Tentativa ${attemptCount})`;
                const userQueryText = finalPromptBase + querySuffix;
                
                // 3. Constrói o Payload com System Instruction
                const payload = {
                    systemInstruction: {
                        parts: [{ text: SYSTEM_INSTRUCTION }]
                    },
                    contents: [{
                        role: "user",
                        parts: [
                            { text: userQueryText },
                            {
                                inlineData: {
                                    mimeType: referenceImage.type,
                                    data: base64ImageData
                                }
                            }
                        ]
                    }],
                    generationConfig: {
                        responseModalities: ["IMAGE"]
                    },
                };

                // 4. Chamada à API e Atualização do Estado.
                const response = await fetchWithRetry(`${IMAGE_API_URL}?key=${API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const result = await response.json();
                const candidate = result?.candidates?.[0];
                const finishReason = candidate?.finishReason;
                const base64Data = candidate?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;
                const mimeType = candidate?.content?.parts?.find(p => p.inlineData)?.inlineData?.mimeType || 'image/png';

                if (base64Data) {
                    newGeneratedImages.push(`data:${mimeType};base64,${base64Data}`);
                    setGeneratedImages([...newGeneratedImages]);
                    setCurrentImageIndex(newGeneratedImages.length - 1); 
                } else {
                    console.error(`Falha ao gerar a imagem ${currentImageNumber} (Tentativa ${attemptCount}).`, result);
                    
                    let errorMessage = `Falha na variação ${currentImageNumber}. Resposta da API inválida.`;
                    
                    if (finishReason === 'SAFETY') {
                        errorMessage = `Falha na variação ${currentImageNumber}. A imagem foi bloqueada por razões de segurança.`;
                    } else if (finishReason === 'NO_IMAGE') {
                        errorMessage = `Falha na variação ${currentImageNumber}. O modelo não conseguiu gerar a imagem.`;
                    } else if (finishReason === 'IMAGE_RECITATION') {
                        // FIX: Tratamento específico para o erro de Recitação
                        errorMessage = `Falha na variação ${currentImageNumber}. Recusa de Geração: A imagem gerada era demasiado semelhante à foto de referência ou a imagens de treino do modelo (Recitação). Tente mudar o prompt para um cenário ou estilo mais distinto.`;
                    } else if (result.error) {
                         errorMessage = `Falha na variação ${currentImageNumber}. Erro da API: ${result.error.message}`;
                    }

                    console.warn(`[AVISO NÃO CRÍTICO - TENTANDO NOVAMENTE] ${errorMessage}`);
                }
            }
            
            setProcessingTime((Date.now() - startTime) / 1000);
            setSuccessMessage(null); // Remove mensagens de sucesso LLM para dar lugar ao sucesso da geração

        } catch (err) {
            console.error("Erro durante a geração/restauração:", err);
            setError(`Ocorreu um erro CRÍTICO: ${err.message}. O processo foi interrompido.`);
        } finally {
            setLoading(false);
            setCurrentGeneratingIndex(0); // Reinicia
        }
    }, [mode, prompt, referenceImage, optimizedPrompt, advancedParams.candidateCount]);

    // Função de download
    const handleDownload = useCallback(() => {
        if (generatedImages[currentImageIndex]) {
            const link = document.createElement('a');
            link.href = generatedImages[currentImageIndex];
            const filename = `${mode === 'generate' ? 'ia-gerada' : 'ia-restaurada'}-${currentImageIndex + 1}.png`;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
    }, [generatedImages, currentImageIndex, mode]);

    // Função de download de todos
    const handleDownloadAll = useCallback(() => {
        if (generatedImages.length === 0) return;
        generatedImages.forEach((base64Url, index) => {
            const link = document.createElement('a');
            link.href = base64Url;
            const filename = `${mode === 'generate' ? 'ia-gerada' : 'ia-restaurada'}-lote-${index + 1}.png`;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        });
    }, [generatedImages, mode]);
    
    // Função de navegação
    const navigateImage = (direction) => {
        setCurrentImageIndex(prevIndex => {
            const newIndex = prevIndex + direction;
            if (newIndex < 0) return generatedImages.length - 1;
            if (newIndex >= generatedImages.length) return 0;
            return newIndex;
        });
    };

    // Componente de Botão de Modo
    const ModeButton = ({ value, label, Icon }) => (
        <button
            onClick={() => {
                setMode(value);
                setGeneratedImages([]);
                setGeneratedCaptions(null);
                setSuggestedBackgrounds(null);
                setCurrentImageIndex(0);
                setReferenceImage(null);
                setImagePreviewUrl(null);
                setPrompt('');
                setError(null);
                setSuccessMessage(null); 
            }}
            className={`flex-1 flex items-center justify-center p-3 rounded-xl transition duration-200 font-semibold text-lg
                ${mode === value
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/50'
                    : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-200'
                }`}
        >
            <Icon className="w-5 h-5 mr-2" />
            {label}
        </button>
    );

    // Componente de Entrada de Parâmetros Avançados
    const AdvancedSetting = ({ label, name, min, max, step }) => (
        <div className="flex justify-between items-center py-2">
            <label htmlFor={name} className="text-sm font-medium text-gray-600">{label}</label>
            <input
                type="number"
                id={name}
                name={name}
                min={min}
                max={max}
                step={step}
                value={advancedParams[name]}
                onChange={(e) => setAdvancedParams(p => ({ ...p, [name]: parseFloat(e.target.value) }))}
                className="w-20 p-2 border border-gray-300 rounded-lg text-sm text-right focus:ring-indigo-500 focus:border-indigo-500"
            />
        </div>
    );
    
    // Utilitário para copiar para a área de transferência
    const copyToClipboard = useCallback(async (text) => {
        try {
            // Usa o comando execCommand como fallback robusto em ambientes iframe
            const el = document.createElement('textarea');
            el.value = text;
            document.body.appendChild(el);
            el.select();
            document.execCommand('copy');
            document.body.removeChild(el);

            setError(null);
            setSuccessMessage("Texto copiado para a área de transferência!"); 
        } catch (err) {
            setSuccessMessage(null);
            setError("Falha ao copiar. O seu navegador pode não suportar esta funcionalidade.");
            console.error('Copy failed:', err);
        }
    }, []);


    return (
        <div className="min-h-screen bg-gray-50 font-sans p-4 sm:p-8">
            <script src="https://cdn.tailwindcss.com"></script>
            <div className="max-w-7xl mx-auto">
                {/* Cabeçalho */}
                <header className="text-center mb-8">
                    <h1 className="text-4xl font-extrabold text-gray-900 flex items-center justify-center">
                        <Zap className="w-8 h-8 text-indigo-600 mr-2" />
                        ImageStudio IA
                    </h1>
                    <p className="text-gray-500 mt-2">Geração e Restauração de Imagens Multimodal com Preservação de Identidade.</p>
                </header>

                {/* Seleção de Modo */}
                <div className="flex gap-4 p-2 bg-gray-200 rounded-xl mb-8 shadow-inner">
                    <ModeButton value="generate" label="Gerar Imagem" Icon={Image} />
                    <ModeButton value="restore" label="Restaurar Foto" Icon={RotateCw} />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    {/* Painel de Controle (Col 1 & 2) */}
                    <div className="lg:col-span-2 space-y-6 bg-white p-6 rounded-2xl shadow-xl border border-gray-100">
                        <h2 className="text-2xl font-bold text-gray-800 border-b pb-2">
                            {mode === 'generate' ? 'Geração Multimodal' : 'Restauração de Qualidade Máxima'}
                        </h2>

                        {/* 1. Upload de Imagem de Referência */}
                        <div className="space-y-3">
                            <label className="block text-lg font-medium text-gray-700">
                                1. Imagem de Referência (Rosto/Foto Antiga)
                            </label>
                            <div className="flex flex-col sm:flex-row items-center gap-4">
                                <label className="flex-grow flex justify-center items-center px-4 py-6 border-2 border-dashed border-indigo-300 rounded-xl cursor-pointer bg-indigo-50 hover:bg-indigo-100 transition-colors">
                                    <CloudUpload className="w-6 h-6 text-indigo-600 mr-2" />
                                    <span className="text-indigo-600 font-medium">
                                        {referenceImage ? `Ficheiro Selecionado: ${referenceImage.name}` : "Clique para Carregar Imagem"}
                                    </span>
                                    <input
                                        type="file"
                                        accept="image/*"
                                        className="hidden"
                                        onChange={handleImageUpload}
                                    />
                                </label>
                                {imagePreviewUrl && (
                                    <div className="relative w-24 h-24 flex-shrink-0">
                                        <img src={imagePreviewUrl} alt="Pré-visualização" className="w-full h-full object-cover rounded-xl shadow-md border-2 border-white" />
                                        <button onClick={() => { setReferenceImage(null); setImagePreviewUrl(null); setGeneratedCaptions(null); setSuggestedBackgrounds(null); setSuccessMessage(null); setError(null); }} className="absolute -top-2 -right-2 bg-red-500 text-white p-1 rounded-full hover:bg-red-600 transition">
                                            <Trash2 className="w-3 h-3" />
                                        </button>
                                    </div>
                                )}
                            </div>
                            <p className="text-xs text-gray-500">
                                A imagem será enviada para a IA para preservar a identidade do rosto em todas as variações.
                            </p>
                        </div>

                        {/* 2. Descrição Textual (Prompt) */}
                        {mode === 'generate' && ( // Este bloco SÓ aparece no modo 'generate'
                            <div className="space-y-3">
                                <label htmlFor="prompt" className="block text-lg font-medium text-gray-700">
                                    2. Descrição Desejada (Cenário/Estilo)
                                </label>
                                <textarea
                                    id="prompt"
                                    rows="3"
                                    value={prompt}
                                    onChange={(e) => setPrompt(e.target.value)}
                                    placeholder="Ex: 'em uma armadura medieval de ouro no meio de um castelo em ruínas, iluminação dramática.'"
                                    className="w-full p-4 border border-gray-300 rounded-xl focus:ring-indigo-500 focus:border-indigo-500 resize-none transition-shadow"
                                ></textarea>
                                
                                {/* Botões LLM */}
                                <div className="flex flex-col gap-2">
                                    {/* RECURSO LLM: Otimizador de Prompt */}
                                    <button
                                        onClick={handlePromptEnhance}
                                        disabled={!prompt || isEnhancing || loading || isCaptioning || isSuggesting}
                                        className="w-full flex items-center justify-center py-2 px-4 border border-transparent text-sm font-semibold rounded-xl text-white bg-pink-500 hover:bg-pink-600 focus:outline-none focus:ring-4 focus:ring-pink-500 focus:ring-opacity-50 disabled:bg-pink-300 transition duration-150"
                                    >
                                        {isEnhancing ? (
                                            <>
                                                <span className="animate-spin mr-2 border-2 border-white border-t-transparent rounded-full h-4 w-4"></span>
                                                Otimizando...
                                            </>
                                        ) : (
                                            <>
                                                <Wand2 className="w-4 h-4 mr-2" />
                                                ✨ Otimizar Prompt IA ✨
                                            </>
                                        )}
                                    </button>

                                    {/* NOVO RECURSO LLM: Sugerir Fundos */}
                                    <button
                                        onClick={handleBackgroundSuggestion}
                                        disabled={!referenceImage || isSuggesting || loading || isEnhancing || isCaptioning}
                                        className="w-full flex items-center justify-center py-2 px-4 border border-transparent text-sm font-semibold rounded-xl text-white bg-orange-500 hover:bg-orange-600 focus:outline-none focus:ring-4 focus:ring-orange-500 focus:ring-opacity-50 disabled:bg-orange-300 transition duration-150"
                                    >
                                        {isSuggesting ? (
                                            <>
                                                <span className="animate-spin mr-2 border-2 border-white border-t-transparent rounded-full h-4 w-4"></span>
                                                A Analisar Imagem...
                                            </>
                                        ) : (
                                            <>
                                                <Star className="w-4 h-4 mr-2" />
                                                ✨ Sugerir Fundos IA ✨
                                            </>
                                        )}
                                    </button>
                                </div>
                                
                                <p className="text-sm text-gray-500 mt-2">
                                    <span className="font-semibold">Prompt Final (Base para a IA):</span> {optimizedPrompt}
                                </p>
                            </div>
                        )}

                        {/* Display de Sugestões de Fundo */}
                        {suggestedBackgrounds && (
                            <div className="bg-white border border-orange-200 rounded-xl p-4 shadow-inner">
                                <h3 className="font-bold text-orange-700 mb-2 flex items-center">
                                    <MessageSquare className="w-4 h-4 mr-1"/> Sugestões de Fundos para a sua Pessoa:
                                </h3>
                                <ul className="space-y-2 text-sm text-gray-700 list-disc list-inside">
                                    {suggestedBackgrounds.map((suggestion, index) => (
                                        <li key={index} className="flex items-start">
                                            <span className="flex-grow">{suggestion}</span>
                                            <button 
                                                onClick={() => copyToClipboard(suggestion)}
                                                className="text-orange-600 hover:text-orange-800 flex-shrink-0 ml-2"
                                                title="Copiar Sugestão para Prompt"
                                            >
                                                {/* Ícone de Cópia */}
                                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="10" y="4" width="12" height="12" rx="2" ry="2"></rect><path d="M16 8v-2a2 2 0 0 0 -2 -2h-8a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h2"></path></svg>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {/* 3. Configurações Avançadas */}
                        <div className="border border-gray-200 rounded-xl p-4 bg-gray-50">
                            <button
                                onClick={() => setIsAdvancedOpen(!isAdvancedOpen)}
                                className="flex items-center w-full justify-between text-lg font-medium text-gray-700"
                            >
                                <div className='flex items-center'>
                                    <Settings className="w-5 h-5 mr-2 text-indigo-600" />
                                    Configurações Avançadas
                                </div>
                                <span className="text-indigo-600">{isAdvancedOpen ? 'Ocultar' : 'Mostrar'}</span>
                            </button>
                            {isAdvancedOpen && (
                                <div className="mt-4 space-y-2">
                                    <AdvancedSetting label="Passos de Geração (Steps)" name="steps" min={10} max={150} step={1} />
                                    <AdvancedSetting label="Escala CFG (CFG Scale)" name="cfgScale" min={1.0} max={30.0} step={0.5} />
                                    <AdvancedSetting label="Semente de Geração (Seed)" name="seed" min={0} max={999999} step={1} />
                                    <AdvancedSetting label="Variações (Geração Iterativa)" name="candidateCount" min={1} max={5} step={1} />
                                    <p className="text-xs text-gray-500 mt-2 pt-2 border-t">
                                        O sistema fará {advancedParams.candidateCount} chamadas individuais à API para gerar variações.
                                    </p>
                                </div>
                            )}
                        </div>

                        {/* Botão de Ação */}
                        <button
                            onClick={handleGenerate}
                            disabled={loading || isEnhancing || isCaptioning || isSuggesting || !referenceImage || (mode === 'generate' && !prompt)}
                            className="w-full flex items-center justify-center py-3 px-4 border border-transparent text-xl font-bold rounded-xl text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-4 focus:ring-indigo-500 focus:ring-opacity-50 disabled:bg-indigo-400 disabled:cursor-not-allowed transition duration-150 shadow-lg"
                        >
                            {loading ? (
                                <>
                                    <span className="animate-spin mr-3 border-4 border-white border-t-transparent rounded-full h-6 w-6"></span>
                                    Processando Imagem {currentGeneratingIndex} de {advancedParams.candidateCount}...
                                </>
                            ) : (
                                <>
                                    <Zap className="w-6 h-6 mr-2" />
                                    {'Gerar Variações'}
                                </>
                            )}
                        </button>

                        {/* Indicador de Status - MENSAGEM DE SUCESSO DO LLM */}
                        {successMessage && (
                            <div className="p-3 text-sm font-medium text-teal-700 bg-teal-100 rounded-lg" role="alert">
                                Sucesso: {successMessage}
                            </div>
                        )}
                        
                        {/* Indicador de Status - MENSAGEM DE ERRO */}
                        {error && (
                            <div className="p-3 text-sm font-medium text-red-700 bg-red-100 rounded-lg" role="alert">
                                Erro: {error}
                            </div>
                        )}
                        
                        {/* Indicador de Status - TEMPO DE PROCESSAMENTO (Sucesso de Geração) */}
                        {processingTime > 0 && !error && (
                            <div className="p-3 text-sm font-medium text-green-700 bg-green-100 rounded-lg" role="alert">
                                Geração Concluída! {generatedImages.length} imagem(ns) foi(foram) gerada(s) em {processingTime.toFixed(2)} segundos.
                            </div>
                        )}

                        {/* RECURSO LLM: Gerador de Legendas */}
                        {generatedImages.length > 0 && (
                            <div className="pt-4 border-t border-gray-100 space-y-3">
                                <button
                                    onClick={handleCaptionGenerate}
                                    disabled={isCaptioning || loading || !generatedImages.length || !referenceImage || isSuggesting}
                                    className="w-full flex items-center justify-center py-2 px-4 border border-transparent text-sm font-semibold rounded-xl text-white bg-teal-500 hover:bg-teal-600 focus:outline-none focus:ring-4 focus:ring-teal-500 focus:ring-opacity-50 disabled:bg-teal-300 transition duration-150"
                                >
                                    {isCaptioning ? (
                                        <>
                                            <span className="animate-spin mr-2 border-2 border-white border-t-transparent rounded-full h-4 w-4"></span>
                                            A gerar legendas...
                                        </>
                                    ) : (
                                        <>
                                            <Wand2 className="w-4 h-4 mr-2" />
                                            ✨ Gerar Legendas IA ✨
                                        </>
                                    )}
                                </button>
                                
                                {/* Exibição das Legendas Geradas */}
                                {generatedCaptions && (
                                    <div className="bg-white border border-teal-200 rounded-xl p-4 shadow-inner">
                                        <h3 className="font-bold text-teal-700 mb-2">Sugestões de Legendas:</h3>
                                        <div className="space-y-3 text-sm text-gray-700">
                                            {Object.entries(generatedCaptions).map(([key, value]) => (
                                                <div key={key}>
                                                    <p className="font-semibold text-gray-800 capitalize">{key}:</p>
                                                    <div className="flex items-center space-x-2 bg-teal-50 p-2 rounded-lg border border-teal-100">
                                                        <p className="flex-grow">{value}</p>
                                                        <button 
                                                            onClick={() => copyToClipboard(value)}
                                                            className="text-teal-600 hover:text-teal-800 flex-shrink-0"
                                                            title="Copiar Legenda"
                                                        >
                                                            {/* Ícone de Cópia */}
                                                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="10" y="4" width="12" height="12" rx="2" ry="2"></rect><path d="M16 8v-2a2 2 0 0 0 -2 -2h-8a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h2"></path></svg>
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Área de Exibição de Resultados (Col 3) */}
                    <div className="lg:col-span-1 bg-white p-6 rounded-2xl shadow-xl border border-gray-100 h-full flex flex-col">
                        <h2 className="text-2xl font-bold text-gray-800 border-b pb-2 mb-4">Resultado</h2>

                        <div className="flex-grow flex flex-col items-center justify-center min-h-[300px]">
                            {generatedImages.length > 0 ? (
                                <div className="relative w-full h-full flex flex-col items-center justify-center">
                                    <img
                                        src={generatedImages[currentImageIndex]}
                                        alt={`Variação Gerada ${currentImageIndex + 1}`}
                                        className="w-full max-h-[400px] object-contain rounded-xl shadow-2xl border-4 border-indigo-500"
                                    />
                                    {generatedImages.length > 1 && (
                                        <div className="absolute top-1/2 -translate-y-1/2 flex justify-between w-full px-2">
                                            <button
                                                onClick={() => navigateImage(-1)}
                                                className="bg-indigo-600 text-white p-2 rounded-full shadow-lg hover:bg-indigo-700 transition"
                                            >
                                                <ChevronLeft className="w-6 h-6" />
                                            </button>
                                            <button
                                                onClick={() => navigateImage(1)}
                                                className="bg-indigo-600 text-white p-2 rounded-full shadow-lg hover:bg-indigo-700 transition"
                                            >
                                                <ChevronRight className="w-6 h-6" />
                                            </button>
                                        </div>
                                    )}
                                    <p className="mt-4 text-gray-600">
                                        Variação {currentImageIndex + 1} de {generatedImages.length}
                                    </p>
                                </div>
                            ) : loading ? (
                                <div className="text-center p-8">
                                    <RotateCw className="w-10 h-10 animate-spin text-indigo-500 mx-auto" />
                                    <p className="mt-4 text-gray-600">
                                        Renderizando Imagem {currentGeneratingIndex} de {advancedParams.candidateCount}... <br />
                                        Tempo estimado por imagem: 20-40 segundos.
                                    </p>
                                </div>
                            ) : (
                                <div className="text-center p-8 text-gray-400 border-2 border-dashed border-gray-200 rounded-xl w-full">
                                    <Image className="w-12 h-12 mx-auto mb-2" />
                                    <p>O resultado da sua imagem aparecerá aqui.</p>
                                </div>
                            )}
                        </div>

                        {/* Botões de Download */}
                        {generatedImages.length > 0 && (
                            <div className="mt-6 grid grid-cols-2 gap-4">
                                <button
                                    onClick={handleDownload}
                                    className="w-full flex items-center justify-center py-3 px-4 text-lg font-bold rounded-xl text-white bg-green-500 hover:bg-green-600 focus:outline-none focus:ring-4 focus:ring-green-500 focus:ring-opacity-50 transition duration-150"
                                >
                                    <Download className="w-5 h-5 mr-2" />
                                    Atual ({currentImageIndex + 1})
                                </button>
                                <button
                                    onClick={handleDownloadAll}
                                    className="w-full flex items-center justify-center py-3 px-4 text-lg font-bold rounded-xl text-white bg-gray-600 hover:bg-gray-700 focus:outline-none focus:ring-4 focus:ring-gray-500 focus:ring-opacity-50 transition duration-150"
                                >
                                    <Download className="w-5 h-5 mr-2" />
                                    Baixar Todos ({generatedImages.length})
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default App;
