// Offline tests for the papers feature: fake fetch serving trimmed real samples of arXiv, Semantic Scholar, OpenAlex,
// Crossref and doi.org (captured 2026-11-15), a real SQLite behind a fake hub, fake read_attachment / read_url.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const FX = {
"ATOM_SEARCH": "<?xml version='1.0' encoding='UTF-8'?>\n<feed xmlns:opensearch=\"http://a9.com/-/spec/opensearch/1.1/\" xmlns:arxiv=\"http://arxiv.org/schemas/atom\" xmlns=\"http://www.w3.org/2005/Atom\">\n  <id>https://arxiv.org/api/ptiqhmhGOK8NY8zbElX/iLYaIIc</id>\n  <title>arXiv Query: search_query=all:\"integrated sensing and communication\" AND all:\"beam prediction\"&amp;id_list=&amp;start=0&amp;max_results=3</title>\n  <updated>2026-11-14T19:17:45Z</updated>\n  <link href=\"https://arxiv.org/api/query?search_query=all:%22integrated+sensing+and+communication%22+AND+all:%22beam+prediction%22&amp;start=0&amp;max_results=3&amp;id_list=\" type=\"application/atom+xml\"/>\n  <opensearch:itemsPerPage>3</opensearch:itemsPerPage>\n  <opensearch:totalResults>17</opensearch:totalResults>\n  <opensearch:startIndex>0</opensearch:startIndex>\n  <entry>\n    <id>http://arxiv.org/abs/2401.12801v2</id>\n    <title>Deep Learning-based Target-To-User Association in Integrated Sensing and Communication Systems</title>\n    <updated>2024-09-02T12:37:27Z</updated>\n    <link href=\"https://arxiv.org/abs/2401.12801v2\" rel=\"alternate\" type=\"text/html\"/>\n    <link href=\"https://arxiv.org/pdf/2401.12801v2\" rel=\"related\" type=\"application/pdf\" title=\"pdf\"/>\n    <summary>In Integrated Sensing and Communication (ISAC) systems, matching the radar targets with communication user equipments (UEs) is functional to several communication tasks, such as proactive handover and beam prediction. In this paper, we consider a radar-assisted communication system where a base station (BS) is equipped with a multiple-input-multiple-output (MIMO) radar that has a double aim: (i) associate vehicular radar targets to vehicular equipments (VEs) in the communication beamspace and (ii) predict the beamforming vector for each VE from radar data. The proposed target-to-user (T2U) association consists of two stages. First, vehicular radar targets are detected from range-angle images, and, for each, a beamforming vector is estimated. Then, the inferred per-target beamforming vectors are matched with the ones utilized at the BS for communication to perform target-to-user (T2U) association. Joint multi-target detection and beam inference is obtained by modifying the you only look once (YOLO) model, which is trained over simulated range-angle radar images. Simulation results over different urban vehicular mobility scenarios show that the proposed T2U method provides a probability of correct association that increases with the size of the BS antenna array, highlighting the respective increase of the separability of the VEs in the beamspace. Moreover, we show that the modified YOLO architecture can effectively perform both beam prediction and radar target detection, with similar performance in mean average precision on the latter over different antenna array sizes.</summary>\n    <category term=\"cs.NI\" scheme=\"http://arxiv.org/schemas/atom\"/>\n    <category term=\"cs.LG\" scheme=\"http://arxiv.org/schemas/atom\"/>\n    <category term=\"eess.SP\" scheme=\"http://arxiv.org/schemas/atom\"/>\n    <published>2024-01-11T00:45:33Z</published>\n    <arxiv:primary_category term=\"cs.NI\"/>\n    <author>\n      <name>Lorenzo Cazzella</name>\n    </author>\n    <author>\n      <name>Marouan Mizmizi</name>\n    </author>\n    <author>\n      <name>Dario Tagliaferri</name>\n    </author>\n    <author>\n      <name>Damiano Badini</name>\n    </author>\n    <author>\n      <name>Matteo Matteucci</name>\n    </author>\n    <author>\n      <name>Umberto Spagnolini</name>\n    </author>\n  </entry>\n  <entry>\n    <id>http://arxiv.org/abs/2609.10200v1</id>\n    <title>Robust Beam Prediction for V2X Networks with Multi-Modal Sensing</title>\n    <updated>2026-09-09T14:04:55Z</updated>\n    <link href=\"https://arxiv.org/abs/2609.10200v1\" rel=\"alternate\" type=\"text/html\"/>\n    <link href=\"https://arxiv.org/pdf/2609.10200v1\" rel=\"related\" type=\"application/pdf\" title=\"pdf\"/>\n    <summary>Integrated sensing and communication (ISAC) provides a promising foundation for beam prediction in future vehicle-to-everything (V2X) networks. However, existing sensing-assisted beamforming methods still rely heavily on radio-frequency sensing, which may become unreliable in complex vehicular environments. Meanwhile, the growing availability of heterogeneous sensors, such as cameras and LiDAR, offers new opportunities to improve beam prediction through richer environmental perception. Motivated by this, this paper proposes a multi-modal beam prediction framework for V2X networks. Specifically, we develop BeamTransFuser, a hierarchical Transformer-based architecture that progressively fuses camera, LiDAR, radar, and GPS observations for robust beam prediction. In addition, to handle possible missing modalities in practical deployment, we introduce a generative module that reconstructs missing modality features from the available observations. Experimental results on a real-world multi-modal V2X dataset show that the proposed framework consistently outperforms representative baselines, while the generative module further improves robustness under incomplete sensing conditions.</summary>\n    <category term=\"cs.LG\" scheme=\"http://arxiv.org/schemas/atom\"/>\n    <published>2026-09-09T14:04:55Z</published>\n    <arxiv:comment>6 pages, 3 figures</arxiv:comment>\n    <arxiv:primary_category term=\"cs.LG\"/>\n    <arxiv:journal_ref>GLOBECOM 2026</arxiv:journal_ref>\n    <author>\n      <name>Chen Shang</name>\n    </author>\n    <author>\n      <name>Dinh Thai Hoang</name>\n    </author>\n    <author>\n      <name>Diep N. Nguyen</name>\n    </author>\n    <author>\n      <name>Jiadong Yu</name>\n    </author>\n  </entry>\n  <entry>\n    <id>http://arxiv.org/abs/2511.18594v1</id>\n    <title>Autoencoder for Position-Assisted Beam Prediction in mmWave ISAC Systems</title>\n    <updated>2025-11-23T19:27:29Z</updated>\n    <link href=\"https://arxiv.org/abs/2511.18594v1\" rel=\"alternate\" type=\"text/html\"/>\n    <link href=\"https://arxiv.org/pdf/2511.18594v1\" rel=\"related\" type=\"application/pdf\" title=\"pdf\"/>\n    <summary>Integrated sensing and communication and millimeter wave (mmWave) have emerged as pivotal technologies for 6G networks. However, the narrow nature of mmWave beams requires precise alignments that typically necessitate large training overhead. This overhead can be reduced by incorporating the position information with beam adjustments. This letter proposes a lightweight autorencoder (LAE) model that addresses the position-assisted beam prediction problem while significantly reducing computational complexity compared to the conventional baseline method, i.e., deep fully connected neural network. The proposed LAE is designed as a three-layer undercomplete network to exploit its dimensionality reduction capabilities and thereby mitigate the computational requirements of the trained model. Simulation results show that the proposed model achieves a similar beam prediction accuracy to the baseline with an 83% complexity reduction.</summary>\n    <category term=\"eess.SP\" scheme=\"http://arxiv.org/schemas/atom\"/>\n    <category term=\"cs.LG\" scheme=\"http://arxiv.org/schemas/atom\"/>\n    <published>2025-11-23T19:27:29Z</published>\n    <arxiv:primary_category term=\"eess.SP\"/>\n    <author>\n      <name>Ahmad A. Aziz El-Banna</name>\n    </author>\n    <author>\n      <name>Octavia A. Dobre</name>\n    </author>\n  </entry>\n</feed>\n",
"ATOM_IDS": "<?xml version='1.0' encoding='UTF-8'?>\n<feed xmlns:opensearch=\"http://a9.com/-/spec/opensearch/1.1/\" xmlns:arxiv=\"http://arxiv.org/schemas/atom\" xmlns=\"http://www.w3.org/2005/Atom\">\n  <id>https://arxiv.org/api/0YmSjjAD3O0ffOPNLW8Pf98gr4A</id>\n  <title>arXiv Query: search_query=&amp;id_list=1706.03762v7,cs/0506075&amp;start=0&amp;max_results=10</title>\n  <updated>2026-11-14T19:17:45Z</updated>\n  <link href=\"https://arxiv.org/api/query?search_query=&amp;start=0&amp;max_results=10&amp;id_list=1706.03762v7,cs/0506075\" type=\"application/atom+xml\"/>\n  <opensearch:itemsPerPage>10</opensearch:itemsPerPage>\n  <opensearch:totalResults>2</opensearch:totalResults>\n  <opensearch:startIndex>0</opensearch:startIndex>\n  <entry>\n    <id>http://arxiv.org/abs/1706.03762v7</id>\n    <title>Attention Is All You Need</title>\n    <updated>2023-08-02T00:41:18Z</updated>\n    <link href=\"https://arxiv.org/abs/1706.03762v7\" rel=\"alternate\" type=\"text/html\"/>\n    <link href=\"https://arxiv.org/pdf/1706.03762v7\" rel=\"related\" type=\"application/pdf\" title=\"pdf\"/>\n    <summary>The dominant sequence transduction models are based on complex recurrent or convolutional neural networks in an encoder-decoder configuration. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. Experiments on two machine translation tasks show these models to be superior in quality while being more parallelizable and requiring significantly less time to train. Our model achieves 28.4 BLEU on the WMT 2014 English-to-German translation task, improving over the existing best results, including ensembles by over 2 BLEU. On the WMT 2014 English-to-French translation task, our model establishes a new single-model state-of-the-art BLEU score of 41.8 after training for 3.5 days on eight GPUs, a small fraction of the training costs of the best models from the literature. We show that the Transformer generalizes well to other tasks by applying it successfully to English constituency parsing both with large and limited training data.</summary>\n    <category term=\"cs.CL\" scheme=\"http://arxiv.org/schemas/atom\"/>\n    <category term=\"cs.LG\" scheme=\"http://arxiv.org/schemas/atom\"/>\n    <published>2017-06-12T17:57:34Z</published>\n    <arxiv:comment>15 pages, 5 figures</arxiv:comment>\n    <arxiv:primary_category term=\"cs.CL\"/>\n    <author>\n      <name>Ashish Vaswani</name>\n    </author>\n    <author>\n      <name>Noam Shazeer</name>\n    </author>\n    <author>\n      <name>Niki Parmar</name>\n    </author>\n    <author>\n      <name>Jakob Uszkoreit</name>\n    </author>\n    <author>\n      <name>Llion Jones</name>\n    </author>\n    <author>\n      <name>Aidan N. Gomez</name>\n    </author>\n    <author>\n      <name>Lukasz Kaiser</name>\n    </author>\n    <author>\n      <name>Illia Polosukhin</name>\n    </author>\n  </entry>\n  <entry>\n    <id>http://arxiv.org/abs/cs/0506075v1</id>\n    <title>Seeing stars: Exploiting class relationships for sentiment categorization with respect to rating scales</title>\n    <updated>2005-06-17T20:10:43Z</updated>\n    <link href=\"https://arxiv.org/abs/cs/0506075v1\" rel=\"alternate\" type=\"text/html\"/>\n    <link href=\"https://arxiv.org/pdf/cs/0506075v1\" rel=\"related\" type=\"application/pdf\" title=\"pdf\"/>\n    <summary>  We address the rating-inference problem, wherein rather than simply decide whether a review is \"thumbs up\" or \"thumbs down\", as in previous sentiment analysis work, one must determine an author's evaluation with respect to a multi-point scale (e.g., one to five \"stars\"). This task represents an interesting twist on standard multi-class text categorization because there are several different degrees of similarity between class labels; for example, \"three stars\" is intuitively closer to \"four stars\" than to \"one star\". We first evaluate human performance at the task. Then, we apply a meta-algorithm, based on a metric labeling formulation of the problem, that alters a given n-ary classifier's output in an explicit attempt to ensure that similar items receive similar labels. We show that the meta-algorithm can provide significant improvements over both multi-class and regression versions of SVMs when we employ a novel similarity measure appropriate to the problem.</summary>\n    <category term=\"cs.CL\" scheme=\"http://arxiv.org/schemas/atom\"/>\n    <category term=\"cs.LG\" scheme=\"http://arxiv.org/schemas/atom\"/>\n    <published>2005-06-17T20:10:43Z</published>\n    <arxiv:comment>To appear, Proceedings of ACL 2005</arxiv:comment>\n    <arxiv:primary_category term=\"cs.CL\"/>\n    <author>\n      <name>Bo Pang</name>\n    </author>\n    <author>\n      <name>Lillian Lee</name>\n    </author>\n  </entry>\n</feed>\n",
"SS_SEARCH": {
"total": 1980,
"offset": 0,
"next": 3,
"data": [
{
"paperId": "390623266fa8751198abc4edffa1878ab51311a9",
"externalIds": {
"DOI": "10.1109/ICCCS65393.2025.11069921",
"CorpusId": 280226351
},
"url": "https://www.semanticscholar.org/paper/390623266fa8751198abc4edffa1878ab51311a9",
"title": "Integrated Sensing, Communication and Control with Deep Reinforcement Learning for Low-Altitude Intelligent Transportation",
"venue": "International Conference on Communication, Computing & Security",
"year": 2025,
"citationCount": 0,
"authors": [
{
"authorId": "3428207",
"name": "Yu-Chuan Fu"
},
{
"authorId": "2372790512",
"name": "Yu-Ting Huang"
},
{
"authorId": "2257046490",
"name": "Chang-Le Li"
},
{
"authorId": "30845733",
"name": "F. Yu"
}
],
"abstract": "With the accelerating pace of global urbanization, the development of Low-Altitude Intelligent Transportation (LAIT) systems powered by electric Vertical Take-Off and Landing (eVTOL) aircraft has become a critical strategic direction to mitigate urban development pressures. However, the operational complexity of eVTOLs in dense urban environments, combined with their high-speed maneuverability, presents significant tech-nical challenges for LA IT systems, including frequent communication link interruptions and difficulties in achieving coordinated control among multiple e VTOLs. To address these challenges, this paper proposes a novel deep reinforcement learning-based communication-sensing cooperative control approach that seam-lessly integrates beam prediction, base station handover, and trajectory planning into a unified approach. The proposed approach employs adaptive beamforming and intelligent handover mechanisms to dynamically optimize communication quality in real time, while incorporating communication performance as a key constraint within the trajectory planning process. This enables a tightly coupled optimization of communication resources and flight trajectories, overcoming the limitations of conventional decoupled communication and control designs. The result is a closed-loop system that simultaneously enhances communication reliability and flight performance. Simulation results demonstrate that the proposed approach significantly enhances communication quality during eVTOL operations while maintaining reliable connectivity and improving transportation efficiency."
},
{
"paperId": "0abb327a95a3886d6fc4724097a7ab686415bd92",
"externalIds": {
"DOI": "10.1109/ISAP62502.2024.10846363",
"CorpusId": 275852677
},
"url": "https://www.semanticscholar.org/paper/0abb327a95a3886d6fc4724097a7ab686415bd92",
"title": "Integrated Sensing and Communications Signal SINR Prediction with Multi-Beam Statistical Channel",
"venue": "International Symposium on Antennas and Propagation",
"year": 2024,
"citationCount": 0,
"authors": [
{
"authorId": "2479316316",
"name": "Xin-Hao Li"
},
{
"authorId": "2244141857",
"name": "Yi-Hang Jiang"
},
{
"authorId": "2292270095",
"name": "Fan-Yi Meng"
},
{
"authorId": "2292590180",
"name": "Xiao-Yang Li"
},
{
"authorId": "2321665692",
"name": "Kai-Feng Han"
},
{
"authorId": "2237391636",
"name": "Guang-Xu Zhu"
}
],
"abstract": "The development of integrated sensing and communication (ISAC) brings new challenges to network optimization. This is not only due to the unpredictable relationship between ISAC network performance and network parameters but also the lack of well-suited ISAC channel models for ISAC network optimization. We propose a framework of multi-beam statistical channel modeling aided ISAC signal signal-to-interference-plus-noise ratios (SINR) prediction, utilizing channel angular power spectrum to accurately characterize both echo signal and communication signal-to-interference-plus-noise ratio after antenna parameter adjustment. Utilizing real-world driving test data for multi-path channel estimation, this framework accurately characterizes the stochastic sensing channels and provides effective prediction strategies for antenna parameter adjustments. Simulation results demonstrate that our approach outperforms the conventional method with a single-beam path loss model."
},
{
"paperId": "8f5c3110747360f49dd9e56b0d9df84a211af81b",
"externalIds": {
"ArXiv": "2505.02381",
"DBLP": "conf/pimrc/ZhangYHSZL25",
"DOI": "10.1109/PIMRC62392.2025.11275056",
"CorpusId": 278328125
},
"url": "https://www.semanticscholar.org/paper/8f5c3110747360f49dd9e56b0d9df84a211af81b",
"title": "Multimodal Deep Learning-Empowered Beam Prediction in Future THz ISAC Systems",
"venue": "IEEE International Symposium on Personal, Indoor and Mobile Radio Communications",
"year": 2025,
"citationCount": 17,
"openAccessPdf": {
"url": "https://arxiv.org/pdf/2505.02381",
"status": "GREEN",
"license": null,
"disclaimer": "Notice: Paper or abstract available at https://arxiv.org/abs/2505.02381, which is subject to the license by the author or copyright owner provided with this content. Please go to the source to verify the license and copyright information for your use."
},
"authors": [
{
"authorId": "2346045577",
"name": "Kai Zhang"
},
{
"authorId": "2116673666",
"name": "Wen-Tao Yu"
},
{
"authorId": "8787698",
"name": "Heng-Tao He"
},
{
"authorId": "2197843877",
"name": "Sheng-Hui Song"
},
{
"authorId": "2243339483",
"name": "Jun Zhang"
},
{
"authorId": "145142172",
"name": "K. Letaief"
}
],
"abstract": "Integrated sensing and communication (ISAC) systems operating at terahertz (THz) bands are envisioned to enable both ultra-high data-rate communication and precise environmental awareness for next-generation wireless networks. However, the narrow width of THz beams makes them prone to misalignment and necessitates frequent beam prediction in dynamic environments. Multimodal sensing, which integrates complementary modalities such as camera images, positional data, and radar measurements, has recently emerged as a promising solution for proactive beam prediction. Nevertheless, existing multimodal approaches typically employ static fusion architectures that cannot adjust to varying modality reliability and contributions, thereby degrading predictive performance and robustness. To address this challenge, we propose a novel and efficient multimodal mixtureof-experts (MoE) deep learning framework for proactive beam prediction in THz ISAC systems. The proposed multimodal MoE framework employs multiple modality-specific expert networks to extract representative features from individual sensing modalities, and dynamically fuses them using adaptive weights generated by a gating network according to the instantaneous reliability of each modality. Simulation results in realistic vehicle-to-infrastructure (V2I) scenarios demonstrate that the proposed MoE framework outperforms traditional static fusion methods and unimodal baselines in terms of prediction accuracy and adaptability, highlighting its potential in practical THz ISAC systems with ultra-massive multiple-input multiple-output (MIMO)."
}
]
},
"SS_REFS": {
"offset": 0,
"next": 3,
"data": [
{
"citedPaper": {
"paperId": "032274e57f7d8b456bd255fe76b909b2c1d7458e",
"externalIds": {
"DBLP": "conf/iclr/PaulusXS18",
"MAG": "2612675303",
"ArXiv": "1705.04304",
"DOI": "10.48550/arXiv.1705.04304",
"CorpusId": 21850704
},
"title": "A Deep Reinforced Model for Abstractive Summarization",
"year": 2017,
"citationCount": 1792,
"authors": [
{
"authorId": "2896063",
"name": "Romain Paulus"
},
{
"authorId": "2228109",
"name": "Caiming Xiong"
},
{
"authorId": "2166511",
"name": "R. Socher"
}
]
}
},
{
"citedPaper": {
"paperId": "43428880d75b3a14257c3ee9bda054e61eb869c0",
"externalIds": {
"MAG": "2964265128",
"ArXiv": "1705.03122",
"DBLP": "conf/icml/GehringAGYD17",
"DOI": "10.48550/arXiv.1705.03122",
"CorpusId": 3648736
},
"title": "Convolutional Sequence to Sequence Learning",
"year": 2017,
"citationCount": 3594,
"authors": [
{
"authorId": "2401865",
"name": "Jonas Gehring"
},
{
"authorId": "2325985",
"name": "M. Auli"
},
{
"authorId": "2529182",
"name": "D. Grangier"
},
{
"authorId": "13759615",
"name": "D. Yarats"
},
{
"authorId": "2921469",
"name": "Y. Dauphin"
}
]
}
},
{
"citedPaper": {
"paperId": "4550a4c714920ef57d19878e31c9ebae37b049b2",
"externalIds": {
"MAG": "2952564229",
"ACL": "D17-1151",
"ArXiv": "1703.03906",
"DBLP": "journals/corr/BritzGLL17",
"DOI": "10.18653/v1/D17-1151",
"CorpusId": 2201909
},
"title": "Massive Exploration of Neural Machine Translation Architectures",
"year": 2017,
"citationCount": 556,
"authors": [
{
"authorId": "3908643",
"name": "Denny Britz"
},
{
"authorId": "46684455",
"name": "Anna Goldie"
},
{
"authorId": "1707242",
"name": "Minh-Thang Luong"
},
{
"authorId": "2827616",
"name": "Quoc V. Le"
}
]
}
}
]
},
"SS_CITES": {
"offset": 0,
"next": 3,
"data": [
{
"isInfluential": false,
"citingPaper": {
"paperId": "cdceaedf406a3bac0d441a7a9880a6ce711dcbef",
"externalIds": {
"DBLP": "journals/rcim/QiuZYPW27",
"DOI": "10.1016/j.rcim.2026.103375",
"CorpusId": 290129826
},
"title": "Closed-loop intelligent quality control for robotic welding: A survey on architecture, technologies, and system integration",
"year": 2027,
"citationCount": 0,
"authors": [
{
"authorId": "2449564930",
"name": "Cheng Qiu"
},
{
"authorId": "2449596459",
"name": "Wei Zhou"
},
{
"authorId": "2261936303",
"name": "Li Yang"
},
{
"authorId": "2110679301",
"name": "Yong Peng"
},
{
"authorId": "47373067",
"name": "Ke-Hong Wang"
}
]
}
},
{
"isInfluential": false,
"citingPaper": {
"paperId": "29f1060406d7cdc48183812d940a7822d66263e4",
"externalIds": {
"DBLP": "journals/rcim/LiuZS27",
"DOI": "10.1016/j.rcim.2026.103392",
"CorpusId": 290556244
},
"title": "Sim-to-real robotic grinding control via physics-enhanced learning and predictive optimization for unknown surface features",
"year": 2027,
"citationCount": 0,
"authors": [
{
"authorId": "47417628",
"name": "Dong-Cai Liu"
},
{
"authorId": "2155661660",
"name": "Jun Zhang"
},
{
"authorId": "2119319577",
"name": "Ai-Guo Song"
}
]
}
},
{
"isInfluential": false,
"citingPaper": {
"paperId": "dcd246fd5911a166be1ff9d70b7cb87856ff4283",
"externalIds": {
"DBLP": "journals/eswa/ChenWLGZ27",
"DOI": "10.1016/j.eswa.2026.134391",
"CorpusId": 292162065
},
"title": "Joint imputation of multiple highly sparse remote sensing observations with heterogeneous mixture of experts",
"year": 2027,
"citationCount": 0,
"authors": [
{
"authorId": "2501701129",
"name": "Qian Chen"
},
{
"authorId": "2198610603",
"name": "Shu-Yu Wang"
},
{
"authorId": "2108736932",
"name": "Wen-Gen Li"
},
{
"authorId": "2054061022",
"name": "J. Guan"
},
{
"authorId": "2501714601",
"name": "Zhen Zhang"
}
]
}
}
]
},
"OA_SEARCH": {
"results": [
{
"id": "https://openalex.org/W4391063608",
"doi": "https://doi.org/10.1016/j.comcom.2024.01.019",
"title": "Integrated sensing and communication-assisted beam rendezvous in airborne networks",
"publication_year": 2024,
"publication_date": "2024-01-21",
"cited_by_count": 3,
"referenced_works_count": 35,
"type": "article",
"open_access": {
"is_oa": false,
"oa_status": "closed",
"oa_url": null,
"any_repository_has_fulltext": false
},
"abstract_inverted_index": null,
"authorships": [
{
"author": {
"display_name": "Xinyu Hong"
}
},
{
"author": {
"display_name": "Na Lv"
}
},
{
"author": {
"display_name": "Ying Pan"
}
}
],
"primary_location": {
"source": {
"display_name": "Computer Communications"
}
},
"best_oa_location": null
},
{
"id": "https://openalex.org/W4406089676",
"doi": "https://doi.org/10.1109/mcom.004.2400281",
"title": "Large Language Models Empower Multimodal Integrated Sensing and Communication",
"publication_year": 2025,
"publication_date": "2025-01-06",
"cited_by_count": 34,
"referenced_works_count": 13,
"type": "article",
"open_access": {
"is_oa": false,
"oa_status": "closed",
"oa_url": null,
"any_repository_has_fulltext": false
},
"abstract_inverted_index": {
"Integrated": [
0
],
"sensing": [
1,
23,
119
],
"and": [
2,
53,
88,
118,
132,
140,
176
],
"communication": [
3,
32,
117
],
"(ISAC)": [
4
],
"is": [
5
],
"considered": [
6
],
"as": [
7
],
"a": [
8,
151
],
"key": [
9
],
"candidate": [
10
],
"technology": [
11
],
"for": [
12,
31,
37,
64,
179
],
"the": [
13,
101,
124,
127,
137,
141,
156,
163
],
"sixth-generation": [
14
],
"(6G)": [
15
],
"wireless": [
16
],
"networks.": [
17
],
"Notably,": [
18
],
"an": [
19,
29,
110
],
"integration": [
20
],
"of": [
21,
67,
126,
130,
159
],
"multimodal": [
22,
57,
86
],
"information": [
24
],
"within": [
25,
167
],
"ISAC": [
26,
38,
112,
131,
168
],
"systems": [
27,
39
],
"promises": [
28
],
"improvement": [
30
],
"performance.": [
33,
120
],
"Nevertheless,": [
34
],
"traditional": [
35
],
"methods": [
36
],
"are": [
40,
61,
82,
93
],
"typically": [
41
],
"designed": [
42
],
"to": [
43,
50,
72,
95,
99,
114,
144,
154
],
"handle": [
44
],
"unimodal": [
45
],
"data,": [
46
],
"making": [
47
],
"it": [
48
],
"challenging": [
49
],
"effectively": [
51
],
"process": [
52
],
"integrate": [
54
],
"semantically": [
55
],
"complex": [
56
],
"information.": [
58
],
"Moreover,": [
59,
134
],
"they": [
60
],
"usually": [
62
],
"customized": [
63
],
"specific": [
65
],
"types": [
66
],
"data": [
68
],
"or": [
69
],
"tasks,": [
70
],
"leading": [
71
],
"poor": [
73
],
"generalization": [
74
],
"ability.": [
75
],
"Multimodal": [
76
],
"large": [
77,
90
],
"language": [
78
],
"models": [
79
],
"(MLLMs),": [
80
],
"which": [
81
],
"trained": [
83
],
"on": [
84
],
"massive": [
85
],
"datasets": [
87
],
"possess": [
89
],
"parameter": [
91
],
"scales,": [
92
],
"expected": [
94
],
"be": [
96,
145
],
"powerful": [
97
],
"tools": [
98
],
"address": [
100
],
"above": [
102
],
"issues.": [
103
],
"In": [
104
],
"this": [
105,
148
],
"article,": [
106
],
"we": [
107,
135,
171
],
"first": [
108
],
"introduce": [
109
],
"MLLM-enabled": [
111
],
"system": [
113,
139
],
"achieve": [
115
],
"enhanced": [
116
],
"We": [
121
],
"begin": [
122
],
"with": [
123
],
"introduction": [
125
],
"fundamental": [
128
],
"principles": [
129
],
"MLLMs.": [
133
],
"present": [
136
],
"overall": [
138
],
"corresponding": [
142
],
"opportunities": [
143
],
"achieved.": [
146
],
"Furthermore,": [
147
],
"article": [
149
],
"provides": [
150
],
"case": [
152
],
"study": [
153
],
"demonstrate": [
155
],
"superior": [
157
],
"performance": [
158
],
"MLLMs": [
160
],
"in": [
161
],
"handling": [
162
],
"beam": [
164
],
"prediction": [
165
],
"task": [
166
],
"systems.": [
169
],
"Finally,": [
170
],
"discuss": [
172
],
"several": [
173
],
"research": [
174
],
"challenges": [
175
],
"potential": [
177
],
"directions": [
178
],
"future": [
180
],
"research.": [
181
]
},
"authorships": [
{
"author": {
"display_name": "Cheng Jiang Lu"
}
},
{
"author": {
"display_name": "Hongliang Zhang"
}
},
{
"author": {
"display_name": "Boya Di"
}
},
{
"author": {
"display_name": "Dusit Tao Niyato"
}
},
{
"author": {
"display_name": "Lingyang Song"
}
}
],
"primary_location": {
"source": {
"display_name": "IEEE Communications Magazine"
}
},
"best_oa_location": null
},
{
"id": "https://openalex.org/W4409724631",
"doi": "https://doi.org/10.1109/icipnp62754.2023.00075",
"title": "Group Federated Learning for Sensing Assisted Beam Prediction in 6G",
"publication_year": 2023,
"publication_date": "2023-10-26",
"cited_by_count": 1,
"referenced_works_count": 14,
"type": "conference-paper",
"open_access": {
"is_oa": false,
"oa_status": "closed",
"oa_url": null,
"any_repository_has_fulltext": false
},
"abstract_inverted_index": {
"In": [
0,
65
],
"the": [
1,
14,
36,
85,
109,
132,
138,
155
],
"future": [
2
],
"6G": [
3
],
"wireless": [
4,
27
],
"communication": [
5,
10,
28,
42,
55,
103
],
"technology,": [
6
],
"Integrated": [
7
],
"sensing": [
8,
20,
24,
101
],
"and": [
9,
62,
89,
102,
123,
126,
146,
150,
154
],
"(ISAC)": [
11
],
"may": [
12
],
"be": [
13,
32
],
"most": [
15
],
"concerned": [
16
],
"key": [
17
],
"technology.": [
18
],
"Radar": [
19
],
"can": [
21,
31,
116
],
"provide": [
22
],
"useful": [
23
],
"information": [
25
],
"for": [
26,
50,
78
],
"environments,": [
29
],
"which": [
30
],
"used": [
33
],
"to": [
34
],
"improve": [
35
],
"performance": [
37,
94
],
"of": [
38,
53,
87,
113
],
"Millimeter": [
39
],
"wave": [
40
],
"(mmWave)": [
41
],
"systems.": [
43
],
"Machine": [
44
],
"learning": [
45,
58,
76,
135
],
"provides": [
46
],
"a": [
47,
70,
98
],
"promising": [
48
],
"approach": [
49
],
"beam": [
51,
81
],
"prediction": [
52,
82,
111,
139
],
"sensing-assisted": [
54,
80
],
"systems": [
56
],
"by": [
57,
144,
161
],
"highly": [
59
],
"complex": [
60
],
"models": [
61
],
"high": [
63
],
"scalability.": [
64
],
"this": [
66,
114
],
"paper,": [
67
],
"we": [
68
],
"propose": [
69
],
"method": [
71,
115
],
"based": [
72
],
"on": [
73
],
"group": [
74
],
"federated": [
75,
134
],
"(GFL)": [
77
],
"guiding": [
79
],
"while": [
83
],
"reducing": [
84
],
"overhead": [
86
],
"calibration": [
88
],
"dataset": [
90
],
"collection.": [
91
],
"This": [
92
],
"method's": [
93
],
"was": [
95
],
"assessed": [
96
],
"using": [
97
],
"real-world": [
99
],
"radar": [
100
],
"dataset.": [
104
],
"Simulation": [
105
],
"results": [
106
],
"show": [
107
],
"that": [
108
],
"top-5": [
110
],
"accuracy": [
112,
140
],
"reach": [
117
],
"90%": [
118
],
"in": [
119,
148
],
"both": [
120
],
"IID": [
121,
149
],
"(independent": [
122
],
"identical": [
124
],
"distribution)": [
125
],
"non-IID": [
127,
151
],
"data": [
128
],
"cases.": [
129
],
"Compared": [
130
],
"with": [
131
],
"basic": [
133
],
"(FL)": [
136
],
"algorithm,": [
137
],
"has": [
141,
158
],
"been": [
142,
159
],
"improved": [
143,
160
],
"5%": [
145
],
"18%": [
147
],
"cases": [
152
],
"respectively,": [
153
],
"convergence": [
156
],
"speed": [
157
],
"about": [
162
],
"2.6": [
163
],
"times.": [
164
]
},
"authorships": [
{
"author": {
"display_name": "Liwen Luo"
}
},
{
"author": {
"display_name": "Zexuan Jing"
}
},
{
"author": {
"display_name": "Junsheng Mu"
}
},
{
"author": {
"display_name": "Xiaojun Jing"
}
}
],
"primary_location": {
"source": {
"display_name": "International Conference on Information Processing and Network Provisioning (ICIPNP)"
}
},
"best_oa_location": null
}
]
},
"CR_SEARCH": {
"message": {
"items": [
{
"DOI": "10.1109/icc45855.2022.9838563",
"title": [
"Simultaneous Beam Sweeping for Multi-Beam Integrated Sensing and Communication"
],
"author": [
{
"given": "Shiqi",
"family": "Chen"
},
{
"given": "Zhiqiang",
"family": "Xiao"
},
{
"given": "Yong",
"family": "Zeng"
}
],
"container-title": [
"ICC 2022 - IEEE International Conference on Communications"
],
"issued": {
"date-parts": [
[
2022,
5,
16
]
]
},
"is-referenced-by-count": 8,
"references-count": 19,
"type": "proceedings-article",
"page": "4438-4443"
},
{
"DOI": "10.66521/2938-9933-2026031401",
"title": [
"Beam Design and Cooperative Positioning Algorithm for Vehicle-mounted Communication and Sensing Integrated System"
],
"author": [
{
"given": null,
"family": "Zhuo Chen"
}
],
"container-title": [
"Innovation Series: Advanced Science"
],
"issued": {
"date-parts": [
[
2026
]
]
},
"is-referenced-by-count": 0,
"references-count": 0,
"type": "journal-article"
},
{
"DOI": "10.1016/j.comcom.2024.01.019",
"title": [
"Integrated sensing and communication-assisted beam rendezvous in airborne networks"
],
"author": [
{
"given": "Xinyu",
"family": "Hong"
},
{
"given": "Na",
"family": "Lv"
},
{
"given": "Ying",
"family": "Pan"
}
],
"container-title": [
"Computer Communications"
],
"issued": {
"date-parts": [
[
2024,
2
]
]
},
"is-referenced-by-count": 4,
"references-count": 35,
"type": "journal-article",
"page": "274-282",
"volume": "216"
}
]
}
},
"BIB_PIMRC": " @inproceedings{Zhang_2025, title={Multimodal Deep Learning-Empowered Beam Prediction in Future THz ISAC Systems}, url={http://dx.doi.org/10.1109/PIMRC62392.2025.11275056}, DOI={10.1109/pimrc62392.2025.11275056}, booktitle={2025 IEEE 36th International Symposium on Personal, Indoor and Mobile Radio Communications (PIMRC)}, publisher={IEEE}, author={Zhang, Kai and Yu, Wentao and He, Hengtao and Song, Shenghui and Zhang, Jun and Letaief, Khaled B.}, year={2025}, month=Sept, pages={1–6} }\n",
"BIB_OPTUNA": " @inproceedings{Akiba_2019, series={KDD ’19}, title={Optuna: A Next-generation Hyperparameter Optimization Framework}, url={http://dx.doi.org/10.1145/3292500.3330701}, DOI={10.1145/3292500.3330701}, booktitle={Proceedings of the 25th ACM SIGKDD International Conference on Knowledge Discovery &amp; Data Mining}, publisher={ACM}, author={Akiba, Takuya and Sano, Shotaro and Yanase, Toshihiko and Ohta, Takeru and Koyama, Masanori}, year={2019}, month=July, pages={2623–2631}, collection={KDD ’19} }\n"
};

// ---------- harness ----------
const P = await import("../src/feat/papers.ts");
const lib = await import("../src/feat/library.ts");
const feature = P.default;
P.net.retryMs = 0; P.net.arxivGapMs = 0;

const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const X = (t, status = 200) => new Response(t, { status, headers: { "content-type": "application/atom+xml" } });
const T = (t, status = 200, type = "text/plain") => new Response(t, { status, headers: { "content-type": type } });
const calls = [];
let routes = [];
globalThis.fetch = async (url, init) => {
  url = String(url);
  calls.push({ url, ua: init?.headers?.["User-Agent"], accept: init?.headers?.Accept });
  for (const [m, h] of routes) if (typeof m === "string" ? url.includes(m) : m.test(url)) { const r = await h(url, init); if (r) return r; }
  return T("not found", 404);
};
const route = (...r) => { routes = r; calls.length = 0; };
const hit = s => calls.filter(c => c.url.includes(s)).length;

function makeHub({ tools = {}, mailto } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT)");
  db.exec(lib.default.schema);
  const hub = {
    env: {}, db, ranTools: [],
    sql: { exec(q, ...b) { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } },
    get: k => (k === "papers:mailto" && mailto ? mailto : (db.prepare("SELECT v FROM kv WHERE k=?").get(k)?.v ?? null)),
    set: (k, v) => { db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v)); },
    shadow: () => "",
    edit: { cfg: () => 40 },
    tools: () => Object.entries(tools).map(([name, fn]) => ({ name, run: async a => { hub.ranTools.push([name, a]); return fn(a); } })),
  };
  return hub;
}
function makeCtx(hub, { cap = 80, conv = "g1" } = {}) {
  const used = {}, files = [];
  const host = {
    cfg: k => (k === "papers_daily" ? cap : 0),
    quota: async (k, lim) => { used[k] = (used[k] || 0) + 1; return used[k] <= lim; },
    keepFile: async (name, bytes) => { files.push({ name, text: new TextDecoder().decode(bytes) }); return "f" + files.length; },
  };
  return { hub, conv, askers: [{ name: "小明" }], host, used, files };
}
const toolOf = ctx => feature.tools(ctx)[0];
const call = (ctx, args) => toolOf(ctx).run(args);

const arxivEntry = (id, title, authors, extra = "") => `<entry><id>http://arxiv.org/abs/${id}v1</id><published>2025-05-05T10:00:00Z</published><title>${title}</title><summary>  We study things. It works well. And more text follows here.</summary>${authors.map(a => `<author><name>${a}</name></author>`).join("")}<arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="eess.SP"/>${extra}</entry>`;
const feed = (...e) => `<?xml version='1.0'?><feed xmlns="http://www.w3.org/2005/Atom">${e.join("")}</feed>`;

// ---------- ids ----------
describe("id recognition", () => {
  const k = s => { const p = P.parseId(s); return p && p.kind + ":" + p.id; };
  test("arXiv new and old style, versions dropped", () => {
    assert.equal(k("2505.02381"), "arxiv:2505.02381");
    assert.equal(k("arXiv:1706.03762v7"), "arxiv:1706.03762");
    assert.equal(k("ArXiv: 2301.1234v2"), "arxiv:2301.1234");
    assert.equal(k("cs/0506075v1"), "arxiv:cs/0506075");
    assert.equal(k("hep-th/9901001"), "arxiv:hep-th/9901001");
    assert.equal(k("math.GT/0309136"), "arxiv:math.GT/0309136");
  });
  test("arXiv URLs of every kind", () => {
    assert.equal(k("https://arxiv.org/abs/2505.02381v3"), "arxiv:2505.02381");
    assert.equal(k("https://arxiv.org/pdf/1706.03762v7.pdf"), "arxiv:1706.03762");
    assert.equal(k("https://www.arxiv.org/html/2505.02381"), "arxiv:2505.02381");
    assert.equal(k("http://arxiv.org/abs/cs/0506075v1"), "arxiv:cs/0506075");
    assert.equal(k("https://arxiv.org/list/cs.LG/recent"), null);
  });
  test("DOIs, doi.org URLs, arXiv-issued DOIs", () => {
    assert.equal(k("10.1109/TWC.2020.2985701"), "doi:10.1109/twc.2020.2985701");
    assert.equal(k("doi:10.1145/3292500.3330701."), "doi:10.1145/3292500.3330701");
    assert.equal(k("https://doi.org/10.1109/PIMRC62392.2025.11275056"), "doi:10.1109/pimrc62392.2025.11275056");
    assert.equal(k("https://dx.doi.org/10.1000%2F182"), "doi:10.1000/182");
    assert.equal(k("10.48550/arXiv.2505.02381"), "arxiv:2505.02381");
  });
  test("Semantic Scholar and OpenAlex ids, junk", () => {
    const h = "390623266fa8751198abc4edffa1878ab51311a9";
    assert.equal(k(h), "ss:" + h);
    assert.equal(k("https://www.semanticscholar.org/paper/Attention-is-All-you-Need/" + h), "ss:" + h);
    assert.equal(k("CorpusId:280226351"), "ss:CorpusId:280226351");
    assert.equal(k("W4391063608"), "oa:W4391063608");
    assert.equal(k("https://openalex.org/W4391063608"), "oa:W4391063608");
    assert.equal(k("attention is all you need"), null);
    assert.equal(k("https://example.com/paper"), null);
    assert.equal(k(""), null);
    assert.equal(k(undefined), null);
  });
});

// ---------- parsing and mapping of the real samples ----------
describe("source mapping", () => {
  test("arXiv Atom: search sample", () => {
    const r = P.parseAtom(FX.ATOM_SEARCH);   // the feed's own header entry has no <entry>, so only papers come out
    assert.equal(r.length, 3);
    assert.equal(r[0].arxiv, "2401.12801");
    assert.equal(r[0].title, "Deep Learning-based Target-To-User Association in Integrated Sensing and Communication Systems");
    assert.ok(r[0].authors.length >= 2 && r[0].authors.every(a => a && !/\n/.test(a)));
    assert.equal(r[0].year, 2024);
    assert.equal(r[0].pdf, "https://arxiv.org/pdf/2401.12801");
    assert.equal(r[0].absUrl, "https://arxiv.org/abs/2401.12801");
    assert.ok(r[0].abstract.length > 100 && !/\s{2,}/.test(r[0].abstract));
  });
  test("arXiv Atom: id_list sample with old-style id, comment, entities", () => {
    const r = P.parseAtom(FX.ATOM_IDS);
    assert.deepEqual(r.map(x => x.arxiv), ["1706.03762", "cs/0506075"]);
    assert.equal(r[0].title, "Attention Is All You Need");
    assert.equal(r[0].authors.length, 8);
    assert.equal(r[0].primary, "cs.CL");
    assert.equal(r[0].comment, "15 pages, 5 figures");
    assert.equal(r[1].year, 2005);
    assert.equal(r[1].pdf, "https://arxiv.org/pdf/cs/0506075");
  });
  test("arXiv error entry and empty feed give nothing", () => {
    const err = feed("<entry><id>http://arxiv.org/api/errors#incorrect_id_format</id><title>Error</title><summary>bad id</summary></entry>");
    assert.deepEqual(P.parseAtom(err), []);
    assert.deepEqual(P.parseAtom(feed()), []);
  });
  test("Semantic Scholar search sample", () => {
    const r = FX.SS_SEARCH.data.map(P.mapSS);
    assert.equal(r.length, 3);
    const z = r[2];
    assert.equal(z.arxiv, "2505.02381");
    assert.equal(z.doi, "10.1109/pimrc62392.2025.11275056");
    assert.equal(z.cites, 17);
    assert.equal(z.year, 2025);
    assert.ok(z.pdf && z.abstract);
    assert.equal(z.authors.length, 6);
    assert.equal(r[0].pdf, undefined);   // closed access and not on arXiv: no PDF claimed
    assert.equal(r[0].absUrl, "https://doi.org/" + r[0].doi);
  });
  test("Semantic Scholar: arXiv-issued DOI is not kept as a DOI", () => {
    const m = P.mapSS({ paperId: "x", title: "T", externalIds: { ArXiv: "1705.04304v2", DOI: "10.48550/arXiv.1705.04304" }, authors: [], venue: "arXiv.org" });
    assert.equal(m.doi, undefined);
    assert.equal(m.arxiv, "1705.04304");
    assert.equal(m.venue, "arXiv");
  });
  test("OpenAlex sample: abstract from the inverted index, DOI, venue, counts", () => {
    const r = FX.OA_SEARCH.results.map(P.mapOA);
    assert.equal(r[0].doi, "10.1016/j.comcom.2024.01.019");
    assert.equal(r[0].venue, "Computer Communications");
    assert.equal(r[0].cites, 3);
    assert.equal(r[0].abstract, undefined);
    assert.ok(r[1].abstract.length > 50 && /^[A-Z]/.test(r[1].abstract));
    assert.equal(r[1].authors.length > 0, true);
    assert.equal(P.unInvert({ hello: [0, 2], world: [1] }), "hello world hello");
  });
  test("OpenAlex: arXiv DOI becomes an arXiv id", () => {
    const m = P.mapOA({ id: "https://openalex.org/W1", doi: "https://doi.org/10.48550/arxiv.2505.02381", title: "X", authorships: [] });
    assert.equal(m.arxiv, "2505.02381"); assert.equal(m.doi, undefined); assert.equal(m.oa, "W1");
  });
  test("Crossref sample", () => {
    const r = FX.CR_SEARCH.message.items.map(P.mapCR);
    assert.equal(r.length, 3);
    assert.equal(r[0].doi, "10.1109/icc45855.2022.9838563");
    assert.equal(typeof r[0].cites, "number");
    assert.ok(r[0].year >= 2022 && r[0].authors.length);
  });
  test("abstract clip: one or two sentences, bounded", () => {
    assert.equal(P.abstractClip("We study X. It works well. More text follows."), "We study X. It works well.");
    const long = "A".repeat(10) + " " + "word ".repeat(100) + ". Next sentence.";
    assert.ok(P.abstractClip(long).length <= 301);
    assert.equal(P.abstractClip(""), "");
  });
});

// ---------- de-duplication ----------
describe("de-duplication", () => {
  const ss = FX.SS_SEARCH.data.map(P.mapSS);
  test("same arXiv id from arXiv and Semantic Scholar merges; the merged record has both sides' strengths", () => {
    const ar = P.parseAtom(feed(arxivEntry("2505.02381", "Multimodal Deep Learning-Empowered Beam Prediction in Future THz ISAC Systems", ["Kai Zhang", "Wentao Yu"])));
    const m = P.dedupe([ar, ss]);
    assert.equal(m.length, 3);   // 1 + 3 - 1
    const z = m.find(p => p.arxiv === "2505.02381");
    assert.equal(z.cites, 17);                       // from Semantic Scholar
    assert.equal(z.authors.length, 6);                // the fuller author list wins
    assert.ok(/^We study things/.test(z.abstract));   // arXiv listed first, so its abstract wins
    assert.equal(z.doi, "10.1109/pimrc62392.2025.11275056");
    assert.match(z.venue, /PIMRC|Personal/i);          // a real venue beats "arXiv"
    assert.ok(z.score > 1 / 60);
  });
  test("same DOI across Semantic Scholar and OpenAlex", () => {
    const oa = P.mapOA({ id: "https://openalex.org/W9", doi: "https://doi.org/" + ss[0].doi.toUpperCase(), title: "Totally different title text here", authorships: [], cited_by_count: 5 });
    const m = P.dedupe([ss, [oa]]);
    assert.equal(m.length, 3);
    assert.equal(m.find(p => p.doi === ss[0].doi).cites, 5);   // larger count kept
  });
  test("no ids at all: normalised title decides", () => {
    const a = { title: "Beam-Prediction with   LiDAR: A Study", authors: ["A B"] }, b = { title: "beam prediction with lidar a study", authors: ["A B", "C D"], cites: 4 };
    const m = P.dedupe([[a], [b]]);
    assert.equal(m.length, 1); assert.equal(m[0].cites, 4); assert.equal(m[0].authors.length, 2);
  });
  test("short titles are not used as a key; different papers stay apart", () => {
    assert.equal(P.dedupe([[{ title: "Survey", authors: [] }], [{ title: "Survey", authors: [] }]]).length, 2);
    assert.equal(P.dedupe([[{ title: "Paper one about beams", authors: [], doi: "10.1/a" }], [{ title: "Paper two about beams", authors: [], doi: "10.1/b" }]]).length, 2);
  });
});

// ---------- search ----------
describe("search", () => {
  const atom = () => X(FX.ATOM_SEARCH);
  const ssOk = () => J(FX.SS_SEARCH);
  const oaOk = () => J(FX.OA_SEARCH);
  const crOk = () => J(FX.CR_SEARCH);

  test("auto: arXiv plus Semantic Scholar, merged, shaped for the model; plain User-Agent, no mailto", async () => {
    route(["export.arxiv.org", atom], ["semanticscholar.org", ssOk]);
    const ctx = makeCtx(makeHub());
    const r = await call(ctx, { op: "search", query: "integrated sensing and communication beam prediction" });
    assert.deepEqual(r.sources.sort(), ["Semantic Scholar", "arXiv"]);
    assert.equal(r.count, 6);
    assert.equal(r.results.length, 6);
    const x = r.results.find(p => p.arxiv === "2505.02381" || p.doi === "10.1109/pimrc62392.2025.11275056");
    assert.equal(x.citations, 17);
    assert.equal(x.authors.length, 3); assert.equal(x.authors_total, 6);
    assert.ok(x.id && x.title && x.abs_url && x.abstract.length <= 301);
    assert.ok(x.pdf_url);
    assert.ok(r.note && r.tip);
    for (const c of calls) { assert.equal(c.ua, "teamagent"); assert.ok(!/mailto|@/.test(c.url), c.url); }
    assert.equal(ctx.used.papers, 1);
  });
  test("a configured contact address is sent as mailto to OpenAlex only when set", async () => {
    route(["openalex.org", oaOk]);
    await call(makeCtx(makeHub()), { op: "search", query: "beam", source: "openalex" });
    assert.ok(!/mailto/.test(calls[0].url));
    route(["openalex.org", oaOk]);
    await call(makeCtx(makeHub({ mailto: "lab@example.org" })), { op: "search", query: "beam", source: "openalex" });
    assert.match(calls[0].url, /mailto=lab%40example\.org/);
  });
  test("query words reach the arXiv query as AND of terms (stop words dropped), phrases kept; year filter; limit", async () => {
    route(["export.arxiv.org", atom], ["semanticscholar.org", ssOk]);
    await call(makeCtx(makeHub()), { op: "search", query: 'beam prediction "integrated sensing" for the UAV', year_from: 2024, limit: 5 });
    const a = decodeURIComponent(calls.find(c => c.url.includes("arxiv")).url);
    assert.match(a, /all:beam\+AND\+all:prediction\+AND\+all:UAV/);
    assert.match(a, /all:"integrated\+sensing"/);
    assert.match(a, /submittedDate:\[202401010000/);
    assert.match(a, /max_results=5/);
    const s = calls.find(c => c.url.includes("semanticscholar")).url;
    assert.match(s, /year=2024-/); assert.match(s, /limit=5/);
  });
  test("limit is capped at 20, default 8", async () => {
    route(["export.arxiv.org", atom], ["semanticscholar.org", ssOk]);
    await call(makeCtx(makeHub()), { op: "search", query: "beam", limit: 99 });
    assert.match(calls.find(c => c.url.includes("arxiv")).url, /max_results=20/);
    route(["export.arxiv.org", atom], ["semanticscholar.org", ssOk]);
    await call(makeCtx(makeHub()), { op: "search", query: "beam" });
    assert.match(calls.find(c => c.url.includes("arxiv")).url, /max_results=8/);
  });
  test("sort=cited puts the most cited first and unknown counts last; recent sorts by date", async () => {
    route(["export.arxiv.org", atom], ["semanticscholar.org", ssOk]);
    const r = await call(makeCtx(makeHub()), { op: "search", query: "beam", sort: "cited" });
    const c = r.results.map(p => p.citations ?? -1);
    assert.deepEqual(c, [...c].sort((a, b) => b - a));
    assert.equal(c[0], 17);
    route(["export.arxiv.org", atom], ["semanticscholar.org", ssOk]);
    const t = await call(makeCtx(makeHub()), { op: "search", query: "beam", sort: "recent" });
    assert.match(calls.find(c => c.url.includes("arxiv")).url, /sortBy=submittedDate/);
    const ys = t.results.map(p => p.year);
    assert.deepEqual(ys, [...ys].sort((a, b) => b - a));
  });
  test("source=arxiv never touches the others", async () => {
    route(["export.arxiv.org", atom]);
    const r = await call(makeCtx(makeHub()), { op: "search", query: "beam", source: "arxiv", sort: "cited" });
    assert.deepEqual(r.sources, ["arXiv"]);
    assert.equal(calls.length, 1);
    assert.ok(r.notes.some(n => /没有引用数/.test(n)));
  });
  test("429 from Semantic Scholar: one retry, then OpenAlex, with a plain note; arXiv results still in", async () => {
    route(["export.arxiv.org", atom], ["semanticscholar.org", () => J({ message: "Too Many Requests" }, 429)], ["openalex.org", oaOk]);
    const r = await call(makeCtx(makeHub()), { op: "search", query: "beam" });
    assert.equal(hit("semanticscholar"), 2);   // first try + one retry
    assert.equal(hit("openalex"), 1);
    assert.equal(hit("crossref"), 0);
    assert.deepEqual(r.sources.sort(), ["OpenAlex", "arXiv"]);
    assert.ok(r.notes.some(n => /Semantic Scholar.*429.*OpenAlex/.test(n)), JSON.stringify(r.notes));
    assert.ok(r.results.length >= 3);
  });
  test("fallback order: Semantic Scholar, OpenAlex, Crossref", async () => {
    route(["export.arxiv.org", atom], ["semanticscholar.org", () => J({}, 429)], ["openalex.org", () => J({}, 429)], ["crossref.org", crOk]);
    const r = await call(makeCtx(makeHub()), { op: "search", query: "beam" });
    const order = calls.map(c => c.url.match(/arxiv|semanticscholar|openalex|crossref/)[0]);
    assert.ok(order.indexOf("semanticscholar") < order.indexOf("openalex") && order.indexOf("openalex") < order.indexOf("crossref"));
    assert.deepEqual(r.sources.sort(), ["Crossref", "arXiv"]);
    assert.ok(r.results.some(p => p.doi === "10.1109/icc45855.2022.9838563"));
  });
  test("source=openalex falls back to Crossref, never to Semantic Scholar", async () => {
    route(["openalex.org", () => J({}, 429)], ["crossref.org", crOk], ["semanticscholar.org", ssOk]);
    const r = await call(makeCtx(makeHub()), { op: "search", query: "beam", source: "openalex" });
    assert.equal(hit("semanticscholar"), 0);
    assert.deepEqual(r.sources, ["Crossref"]);
  });
  test("only arXiv answers: results come back with a note that citation counts are missing", async () => {
    route(["export.arxiv.org", atom]);   // everything else 404s
    const r = await call(makeCtx(makeHub()), { op: "search", query: "beam" });
    assert.deepEqual(r.sources, ["arXiv"]);
    assert.ok(r.notes.some(n => /引用数/.test(n)));
    assert.equal(r.results.length, 3);
  });
  test("everything down: a clear Chinese error, no throw", async () => {
    route(["export.arxiv.org", () => X("", 503)], ["semanticscholar.org", () => J({}, 429)], ["openalex.org", () => J({}, 429)], ["crossref.org", () => J({}, 500)]);
    const r = await call(makeCtx(makeHub()), { op: "search", query: "beam" });
    assert.equal(r.ok, false);
    assert.match(r.error, /限流（429）/); assert.match(r.error, /过几分钟再试/);
  });
  test("a timeout or network error is reported as such", async () => {
    route(["export.arxiv.org", () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }]);
    const r = await call(makeCtx(makeHub()), { op: "search", query: "beam", source: "arxiv" });
    assert.equal(r.ok, false); assert.match(r.error, /超时/);
  });
  test("arXiv with no hits for a long query retries once with OR", async () => {
    let n = 0;
    route(["export.arxiv.org", () => X(++n === 1 ? feed() : FX.ATOM_SEARCH)]);
    const r = await call(makeCtx(makeHub()), { op: "search", query: "one two three four", source: "arxiv" });
    assert.equal(n, 2);
    assert.match(decodeURIComponent(calls[1].url), /all:one\+OR\+all:two/);
    assert.equal(r.results.length, 3);
  });
  test("empty query", async () => {
    const r = await call(makeCtx(makeHub()), { op: "search", query: "  " });
    assert.equal(r.ok, false);
  });
});

// ---------- get ----------
describe("get", () => {
  test("arXiv id: arXiv gives the abstract, Semantic Scholar adds counts and venue", async () => {
    route(["export.arxiv.org", () => X(FX.ATOM_IDS)], [/semanticscholar.*ARXIV:1706\.03762/, () => J({ paperId: "abc", title: "Attention is All you Need", year: 2017, venue: "Neural Information Processing Systems", citationCount: 150000, referenceCount: 41, externalIds: { ArXiv: "1706.03762", DOI: "10.48550/arXiv.1706.03762" }, authors: [{ name: "Ashish Vaswani" }] })]);
    const r = await call(makeCtx(makeHub()), { op: "get", id: "https://arxiv.org/abs/1706.03762v7" });
    assert.equal(r.id, "1706.03762");
    assert.equal(r.citations, 150000); assert.equal(r.references, 41);
    assert.equal(r.venue, "Neural Information Processing Systems");
    assert.equal(r.authors.length, 8);                       // arXiv's full list, not the one-author sample
    assert.ok(r.abstract.startsWith("The dominant sequence transduction"));
    assert.equal(r.pdf_url, "https://arxiv.org/pdf/1706.03762");
    assert.equal(r.comment, "15 pages, 5 figures");
  });
  test("arXiv id with Semantic Scholar rate-limited: still answers, says what is missing", async () => {
    route(["export.arxiv.org", () => X(FX.ATOM_IDS)], ["semanticscholar.org", () => J({}, 429)]);
    const r = await call(makeCtx(makeHub()), { op: "get", id: "1706.03762" });
    assert.equal(r.title, "Attention Is All You Need");
    assert.equal(r.citations, undefined);
    assert.ok(r.notes.some(n => /429/.test(n) && /引用数/.test(n)));
  });
  test("DOI: Semantic Scholar first, then OpenAlex, then Crossref", async () => {
    const doi = "10.1109/icccs65393.2025.11069921";
    route(["semanticscholar.org", () => J({}, 429)], ["openalex.org", () => J({}, 500)], [/api\.crossref\.org\/works\/10\.1109/, () => J({ message: FX.CR_SEARCH.message.items[0] })]);
    const r = await call(makeCtx(makeHub()), { op: "get", id: "https://doi.org/" + doi.toUpperCase() });
    const order = calls.map(c => c.url.match(/semanticscholar|openalex|crossref/)[0]);
    assert.deepEqual([...new Set(order)], ["semanticscholar", "openalex", "crossref"]);
    assert.equal(r.doi, "10.1109/icc45855.2022.9838563");
    assert.ok(r.notes.length);
  });
  test("unknown arXiv number, bad id, unknown DOI", async () => {
    route(["export.arxiv.org", () => X(feed())], ["semanticscholar.org", () => J({}, 404)], ["openalex.org", () => J({}, 404)]);
    const a = await call(makeCtx(makeHub()), { op: "get", id: "2999.99999" });
    assert.equal(a.ok, false); assert.match(a.error, /没有|检查/);
    const b = await call(makeCtx(makeHub()), { op: "get", id: "attention is all you need" });
    assert.equal(b.ok, false); assert.match(b.error, /认不出/);
    route(["semanticscholar.org", () => J({}, 404)], ["openalex.org", () => J({}, 404)], ["crossref.org", () => J({}, 404)]);
    const c = await call(makeCtx(makeHub()), { op: "get", id: "10.1234/doesnotexist" });
    assert.equal(c.ok, false); assert.match(c.error, /没有这个 DOI/);
  });
});

// ---------- BibTeX ----------
describe("bibtex text", () => {
  test("escaping: ampersand, percent, hash, underscore, accents, braces, dashes, math, Greek", () => {
    assert.equal(P.tex("Rate & Power: 50% of #1 user_a"), "Rate \\& Power: 50\\% of \\#1 user\\_a");
    assert.equal(P.tex("François Müller and Björn Østergaard"), "Fran{\\c c}ois M{\\\"u}ller and Bj{\\\"o}rn {\\O}stergaard");
    assert.equal(P.tex("Hołubowicz, Škoda, Garça, Nuñez, Ångström"), "Ho{\\l}ubowicz, {\\v S}koda, Gar{\\c c}a, Nu{\\~n}ez, {\\AA}ngstr{\\\"o}m");
    assert.equal(P.tex("A &amp; B &lt; C"), "A \\& B < C");
    assert.equal(P.tex("pages 1–6 — ok"), "pages 1--6 --- ok");
    assert.equal(P.tex("angle θ and φ"), "angle $\\theta$ and $\\phi$");
    assert.equal(P.tex("cost $O(n_k)$ & more"), "cost $O(n_k)$ \\& more");   // math untouched, text escaped
    assert.equal(P.tex("a {MIMO} system"), "a {MIMO} system");               // balanced braces stay
    assert.equal(P.tex("a \\& b").includes("\\\\&"), false);                  // already-escaped stays single
    assert.equal(P.tex("<i>Deep</i> learning"), "Deep learning");
    assert.ok(!/[^\x00-\x7f]/.test(P.tex("François ’s “x” …")));
  });
  test("unbalanced braces never leak out", () => {
    const t = P.tex("x { y } } {");
    let d = 0, ok = true;
    for (let i = 0; i < t.length; i++) { if (t[i] === "\\") { i++; continue; } if (t[i] === "{") d++; if (t[i] === "}") { d--; if (d < 0) ok = false; } }
    assert.ok(ok && d === 0, t);
  });
  test("title protection: acronyms and camelCase words get braces, ordinary words do not", () => {
    assert.equal(P.tex("Beam Prediction for mmWave ISAC with LiDAR and 6G", { title: true }), "Beam Prediction for {mmWave} {ISAC} with {LiDAR} and {6G}");
    assert.equal(P.tex("A Study of THz-Band Channels", { title: true }), "A Study of {THz}-Band Channels");
  });
  test("author names", () => {
    assert.equal(P.bibName("Khaled B. Letaief").text, "Letaief, Khaled B.");
    assert.equal(P.bibName("Ludwig van Beethoven").text, "van Beethoven, Ludwig");
    assert.equal(P.bibName("Zhang, Kai").text, "Zhang, Kai");
    assert.equal(P.bibName("Martin Luther King Jr.").text, "King, Jr., Martin Luther");
    assert.equal(P.bibName("José García").text, "Garc{\\'\\i}a, Jos{\\'e}");
    assert.equal(P.bibName("OpenAI").text, "{OpenAI}");
  });
  test("keys: firstauthorYEARfirstword, ASCII, lowercase, skips articles", () => {
    assert.equal(P.bibKey(["Ashish Vaswani"], 2017, "Attention Is All You Need"), "vaswani2017attention");
    assert.equal(P.bibKey(["Kai Zhang"], 2025, "The Multimodal Beam Prediction"), "zhang2025multimodal");
    assert.equal(P.bibKey(["Björn Østergaard"], 2020, "A Survey: of Étude"), "ostergaard2020survey");
    assert.equal(P.bibKey(["Ludwig van Beethoven"], 1824, "On the Ninth"), "beethoven1824ninth");
    assert.equal(P.bibKey([], undefined, ""), "anonpaper");
    assert.equal(P.bibKey(["王小明"], 2024, "ISAC-aided Sensing"), "anon2024isac");
  });
});

describe("bibtex op", () => {
  const vaswani = () => X(FX.ATOM_IDS);
  test("arXiv-only paper becomes @misc with eprint fields and a clear note", async () => {
    route(["export.arxiv.org", vaswani], ["semanticscholar.org", () => J({}, 404)]);
    const ctx = makeCtx(makeHub());
    const r = await call(ctx, { op: "bibtex", ids: ["arXiv:1706.03762v7"] });
    assert.equal(r.ok, true);
    assert.match(r.bibtex, /^@misc\{vaswani2017attention,/);
    assert.match(r.bibtex, /eprint = \{1706\.03762\}/);
    assert.match(r.bibtex, /archivePrefix = \{arXiv\}/);
    assert.match(r.bibtex, /primaryClass = \{cs\.CL\}/);
    assert.match(r.bibtex, /year = \{2017\}/);
    assert.match(r.bibtex, /url = \{https:\/\/arxiv\.org\/abs\/1706\.03762\}/);
    assert.match(r.bibtex, /author = \{Vaswani, Ashish and Shazeer, Noam/);
    assert.equal(r.entries[0].type, "misc");
    assert.match(r.entries[0].note, /预印本/);
    assert.equal(ctx.files.length, 0);   // one entry: no file
    assert.equal(r.file, undefined);
  });
  test("Semantic Scholar rate limit: still gives @misc, says the publication check failed", async () => {
    route(["export.arxiv.org", vaswani], ["semanticscholar.org", () => J({}, 429)]);
    const r = await call(makeCtx(makeHub()), { op: "bibtex", ids: ["1706.03762"] });
    assert.equal(r.ok, true);
    assert.match(r.entries[0].note, /没能确认.*429/);
  });
  test("published arXiv paper: uses the publisher's entry from doi.org, cleaned and rekeyed", async () => {
    route(["export.arxiv.org", () => X(feed(arxivEntry("2505.02381", "Multimodal Deep Learning-Empowered Beam Prediction in Future THz ISAC Systems", ["Kai Zhang"])))],
      ["semanticscholar.org", () => J(FX.SS_SEARCH.data[2])],
      ["doi.org/10.1109", (u, init) => { assert.equal(init.headers.Accept, "application/x-bibtex"); return T(FX.BIB_PIMRC, 200, "application/x-bibtex"); }]);
    const r = await call(makeCtx(makeHub()), { op: "bibtex", ids: ["2505.02381"] });
    assert.match(r.bibtex, /^@inproceedings\{zhang2025multimodal,/);
    assert.match(r.bibtex, /booktitle = \{2025 IEEE 36th International Symposium/);
    assert.match(r.bibtex, /pages = \{1--6\}/);
    assert.match(r.bibtex, /doi = \{10\.1109\/pimrc62392\.2025\.11275056\}/);
    assert.match(r.bibtex, /title = \{Multimodal Deep Learning-Empowered Beam Prediction in Future \{THz\} \{ISAC\} Systems\}/);
    assert.match(r.bibtex, /Zhang, Kai and Yu, Wentao and He, Hengtao and Song, Shenghui and Zhang, Jun and Letaief, Khaled B\./);
    assert.ok(!/month|Zhang_2025|dx\.doi|–/.test(r.bibtex));
  });
  test("DOI: doi.org entry, HTML entities and en dash cleaned, & escaped", async () => {
    route(["doi.org/10.1145", () => T(FX.BIB_OPTUNA)]);
    const r = await call(makeCtx(makeHub()), { op: "bibtex", ids: ["10.1145/3292500.3330701"] });
    assert.match(r.bibtex, /^@inproceedings\{akiba2019optuna,/);
    assert.match(r.bibtex, /Knowledge Discovery \\& Data Mining/);
    assert.match(r.bibtex, /pages = \{2623--2631\}/);
    assert.ok(!/&amp;|series|collection|–/.test(r.bibtex));
    assert.match(r.bibtex, /Optuna: A Next-generation Hyperparameter Optimization Framework/);
  });
  test("doi.org serving its HTML error page falls back to metadata", async () => {
    route(["doi.org/10.1109", () => T("<!DOCTYPE html><html><title>Error: DOI Not Found</title>", 200, "text/html")],
      ["semanticscholar.org", () => J(FX.SS_SEARCH.data[0])]);
    const r = await call(makeCtx(makeHub()), { op: "bibtex", ids: ["10.1109/ICCCS65393.2025.11069921"] });
    assert.equal(r.ok, true);
    assert.match(r.bibtex, /^@inproceedings\{/);   // venue is a conference
    assert.match(r.bibtex, /booktitle = \{International Conference on Communication/);
    assert.match(r.bibtex, /doi = \{10\.1109\/icccs65393\.2025\.11069921\}/);
  });
  test("several ids: one arXiv request for all arXiv ids, unique keys, a .bib file kept, bad ids reported", async () => {
    route(["export.arxiv.org", vaswani], ["semanticscholar.org", () => J({}, 404)]);
    const ctx = makeCtx(makeHub());
    const r = await call(ctx, { op: "bibtex", ids: ["1706.03762", "cs/0506075", "nonsense", "1706.03762"] });
    assert.equal(hit("export.arxiv.org"), 1);
    assert.deepEqual(r.entries.map(e => e.key), ["vaswani2017attention", "pang2005seeing", "vaswani2017attentiona"]);
    assert.equal(r.file, "f1");
    assert.equal(ctx.files[0].name, "papers.bib");
    assert.equal(ctx.files[0].text, r.bibtex);
    assert.ok(r.problems.some(p => /nonsense.*认不出/.test(p)));
    assert.equal((r.bibtex.match(/^@/gm) || []).length, 3);
    assert.equal(r.bibtex.split("{").length - 1, r.bibtex.split("}").length - 1);   // braces balance
  });
  test("nothing usable: error; more than 12: refused", async () => {
    assert.equal((await call(makeCtx(makeHub()), { op: "bibtex", ids: [] })).ok, false);
    assert.equal((await call(makeCtx(makeHub()), { op: "bibtex", ids: Array(13).fill("1706.03762") })).ok, false);
    route(["export.arxiv.org", () => X(feed())], ["semanticscholar.org", () => J({}, 404)]);
    const r = await call(makeCtx(makeHub()), { op: "bibtex", ids: ["2999.99999"] });
    assert.equal(r.ok, false);
  });
});

// ---------- save ----------
const pdf = pages => new TextEncoder().encode("%PDF-1.5\n1 0 obj\n<< /Type /Pages /Kids [2 0 R] /Count " + pages + " >>\nendobj\n" + "x".repeat(2000) + "\n%%EOF");
const longText = n => ("This is the body of the paper discussing beam prediction with lidar and gps. ").repeat(n);
describe("save", () => {
  const ATOM_1 = () => X(feed(arxivEntry("2505.02381", "Multimodal Deep Learning-Empowered Beam Prediction in Future THz ISAC Systems", ["Kai Zhang", "Wentao Yu"], "<arxiv:comment>9 pages</arxiv:comment>")));
  const base = (pages, extra = []) => [["export.arxiv.org", ATOM_1], ["semanticscholar.org", () => J({}, 404)], [/arxiv\.org\/pdf\//, () => new Response(pdf(pages), { status: 200, headers: { "content-type": "application/pdf" } })], ...extra];

  test("open PDF within the page limit: read_attachment on the PDF url, stored in the library's doc table, found by library search", async () => {
    route(...base(12));
    const hub = makeHub({ tools: { read_attachment: a => ({ pages: 12, content: "OCR " + longText(60) }), read_url: () => { throw new Error("should not be used"); } } });
    const ctx = makeCtx(hub);
    assert.deepEqual(await lib.searchDocs(hub, "g1", { query: "beam" }), []);   // creates the full-text index first, as in production
    const r = await call(ctx, { op: "save", id: "2505.02381v2" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.stored, "全文（PDF 识别）");
    assert.equal(r.pages, 12);
    assert.deepEqual(hub.ranTools.map(t => t[0]), ["read_attachment"]);
    assert.equal(hub.ranTools[0][1].url, "https://arxiv.org/pdf/2505.02381");
    const row = hub.db.prepare("SELECT * FROM doc WHERE id=?").get(r.id);
    assert.equal(row.kind, "paper"); assert.equal(row.status, "ok"); assert.equal(row.conv, "g1"); assert.equal(row.by, "小明");
    assert.equal(row.url, "https://arxiv.org/abs/2505.02381");
    assert.match(row.title, /Multimodal Deep Learning/);
    assert.match(row.text, /^标题：Multimodal Deep Learning/); assert.match(row.text, /摘要：We study things/); assert.match(row.text, /正文：\nOCR /);
    assert.ok(row.chars > 4000 && row.text.length <= 60000);
    // the library tool finds and reads it
    const found = await lib.searchDocs(hub, "g1", { query: "lidar" });
    assert.equal(found.length, 1); assert.equal(found[0].id, r.id);
    const byTitle = await lib.searchDocs(hub, "g1", { query: "THz ISAC" });
    assert.equal(byTitle[0].id, r.id);
    const tool = lib.default.tools({ hub, conv: "g1", host: ctx.host, askers: [] })[0];
    const got = await tool.run({ op: "get", id: r.id });
    assert.match(got.text, /beam prediction with lidar/);
    // saving again does not duplicate
    const again = await call(ctx, { op: "save", id: "arXiv:2505.02381" });
    assert.equal(again.already, true); assert.equal(again.id, r.id);
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM doc").get().n, 1);
  });
  test("works before the library has built its full-text index (it backfills our row later)", async () => {
    route(...base(8));
    const hub = makeHub({ tools: { read_attachment: () => ({ content: longText(60) }) } });
    const r = await call(makeCtx(hub), { op: "save", id: "2505.02381" });
    assert.equal(r.ok, true);
    assert.equal((await lib.searchDocs(hub, "g1", { query: "lidar" })).length, 1);
  });
  test("page guard: over 40 pages is not sent to OCR and falls back to the HTML version", async () => {
    route(...base(55, [["arxiv.org/html/2505.02381", () => T("")]]));
    const hub = makeHub({ tools: { read_attachment: () => { throw new Error("must not be called"); }, read_url: a => ({ title: "x", content: longText(60) }) } });
    const r = await call(makeCtx(hub), { op: "save", id: "2505.02381" });
    assert.equal(r.ok, true);
    assert.equal(r.stored, "全文（arXiv 网页版）");
    assert.deepEqual(hub.ranTools.map(t => t[0]), ["read_url"]);
    assert.equal(hub.ranTools[0][1].url, "https://arxiv.org/html/2505.02381");
    assert.ok(r.notes.some(n => /55 页/.test(n) && /full/.test(n)));
  });
  test("page guard: full:true lets a long PDF through", async () => {
    route(...base(55));
    const hub = makeHub({ tools: { read_attachment: () => ({ pages: 55, content: longText(60) }) } });
    const r = await call(makeCtx(hub), { op: "save", id: "2505.02381", full: true });
    assert.equal(r.stored, "全文（PDF 识别）");
    assert.equal(r.pages, 55);
  });
  test("page count falls back to the arXiv comment when the PDF hides its page tree", async () => {
    assert.equal(P.pdfPageCount(pdf(7)), 7);
    assert.equal(P.pdfPageCount(new TextEncoder().encode("%PDF-1.7 \nstream\n\u0000\u0001 compressed")), null);
    assert.equal(P.pdfPageCount(new TextEncoder().encode("<< /Type /Page /Parent 1 0 R >> << /Type /Page /Parent 1 0 R >> << /Type /Pages /Kids [] >>")), 2);
    route(["export.arxiv.org", () => X(feed(arxivEntry("2505.02381", "Some Long Paper Title Here", ["A B"], "<arxiv:comment>81 pages, 20 figures</arxiv:comment>")))],
      ["semanticscholar.org", () => J({}, 404)], [/arxiv\.org\/pdf\//, () => new Response(new TextEncoder().encode("%PDF-1.7 opaque"), { status: 200 })],
      ["arxiv.org/html", () => T("")]);
    const hub = makeHub({ tools: { read_attachment: () => { throw new Error("no"); }, read_url: () => ({ content: longText(60) }) } });
    const r = await call(makeCtx(hub), { op: "save", id: "2505.02381" });
    assert.equal(r.stored, "全文（arXiv 网页版）"); assert.ok(r.notes.some(n => /81 页/.test(n)));
  });
  test("no PDF, no HTML: abstract and metadata only", async () => {
    route(["semanticscholar.org", () => J({ paperId: "p", title: "A Closed Paper About Beams and Lidar", year: 2024, venue: "IEEE TWC", citationCount: 3, externalIds: { DOI: "10.1109/TWC.2024.1" }, abstract: "Closed access abstract about beams. Second sentence here.", authors: [{ name: "Li Wei" }] })]);
    const hub = makeHub({ tools: { read_attachment: () => { throw new Error("no pdf"); }, read_url: () => { throw new Error("no"); } } });
    const r = await call(makeCtx(hub), { op: "save", id: "10.1109/TWC.2024.1" });
    assert.equal(r.ok, true); assert.equal(r.stored, "仅摘要");
    assert.equal(hub.ranTools.length, 0);
    const row = hub.db.prepare("SELECT * FROM doc WHERE id=?").get(r.id);
    assert.equal(row.url, "https://doi.org/10.1109/twc.2024.1");
    assert.match(row.text, /Closed access abstract/); assert.ok(!/正文：/.test(row.text));
    assert.ok(row.chars < 4000);
  });
  test("an abstract-only entry is upgraded in place when full text becomes available", async () => {
    const hub = makeHub({ tools: { read_attachment: () => ({ content: longText(60) }) } });
    route(["export.arxiv.org", ATOM_1], ["semanticscholar.org", () => J({}, 404)], [/arxiv\.org\/pdf\//, () => new Response(pdf(90), { status: 200 })], ["arxiv.org/html", () => T("")]);
    const first = await call(makeCtx(hub), { op: "save", id: "2505.02381" });   // 90 pages, guarded: abstract only
    assert.equal(first.stored, "仅摘要");
    route(["export.arxiv.org", ATOM_1], ["semanticscholar.org", () => J({}, 404)], [/arxiv\.org\/pdf\//, () => new Response(pdf(90), { status: 200 })]);
    const second = await call(makeCtx(hub), { op: "save", id: "2505.02381", full: true });
    assert.equal(second.id, first.id);
    assert.equal(second.stored, "全文（PDF 识别）");
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM doc").get().n, 1);
    assert.equal((await lib.searchDocs(hub, "g1", { query: "lidar" })).length, 1);
  });
  test("OCR failure falls back to HTML; OCR daily allowance is enforced", async () => {
    route(...base(10, [["arxiv.org/html", () => T("")]]));
    const hub = makeHub({ tools: { read_attachment: () => ({ ok: false, error: "识别失败（500）" }), read_url: () => ({ content: longText(60) }) } });
    const r = await call(makeCtx(hub), { op: "save", id: "2505.02381" });
    assert.equal(r.stored, "全文（arXiv 网页版）"); assert.ok(r.notes.some(n => /PDF 没读成/.test(n)));
    // 10 OCR a day
    const ctx = makeCtx(makeHub({ tools: { read_attachment: () => ({ content: longText(60) }), read_url: () => ({ content: "" }) } }));
    for (let i = 0; i < 10; i++) await ctx.host.quota("papers_ocr", P.OCR_DAILY);
    route(...base(10));
    const capped = await call(ctx, { op: "save", id: "2505.02381" });
    assert.equal(capped.stored, "仅摘要"); assert.ok(capped.notes.some(n => /次数用完/.test(n)));
    assert.equal(ctx.hub.ranTools.filter(t => t[0] === "read_attachment").length, 0);
  });
  test("bad id and unknown paper", async () => {
    assert.equal((await call(makeCtx(makeHub()), { op: "save", id: "hello" })).ok, false);
    route(["export.arxiv.org", () => X(feed())], ["semanticscholar.org", () => J({}, 404)], ["openalex.org", () => J({}, 404)]);
    assert.equal((await call(makeCtx(makeHub()), { op: "save", id: "2999.99999" })).ok, false);
  });
});

// ---------- related ----------
describe("related", () => {
  test("Semantic Scholar: references by citations, citing papers with influential first, 8 at most", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ isInfluential: i === 20, citedPaper: { paperId: "r" + i, title: "Ref " + i, year: 2000 + i % 20, citationCount: i, externalIds: {}, authors: [{ name: "A " + i }] }, citingPaper: { paperId: "c" + i, title: "Cite " + i, year: 2024, citationCount: i, externalIds: { ArXiv: "2401." + String(1000 + i) }, authors: [{ name: "B " + i }] } }));
    route([/\/references/, () => J({ data: many })], [/\/citations/, () => J({ data: many })]);
    const r = await call(makeCtx(makeHub()), { op: "related", id: "1706.03762" });
    assert.equal(r.references.length, 8); assert.equal(r.cited_by.length, 8);
    assert.deepEqual(r.references.slice(0, 2).map(x => x.title), ["Ref 29", "Ref 28"]);
    assert.equal(r.cited_by[0].title, "Cite 20"); assert.equal(r.cited_by[0].influential, true);
    assert.ok(calls[0].url.includes("ARXIV:1706.03762"));
    assert.equal(r.source, "Semantic Scholar");
  });
  test("real samples map cleanly", async () => {
    route([/\/references/, () => J(FX.SS_REFS)], [/\/citations/, () => J(FX.SS_CITES)]);
    const r = await call(makeCtx(makeHub()), { op: "related", id: "10.48550/arXiv.1706.03762" });
    assert.equal(r.references.length, 3); assert.equal(r.cited_by.length, 3);
    assert.ok(r.references[0].citations >= r.references[1].citations);
    assert.ok(r.references.every(x => x.id && x.title));
  });
  test("429: falls back to OpenAlex's graph, says so", async () => {
    route([/semanticscholar/, () => J({}, 429)],
      [/openalex\.org\/works\/https/, () => J(FX.OA_SEARCH.results[1])],
      [/filter=cited_by/, () => J({ results: FX.OA_SEARCH.results.slice(0, 2) })], [/filter=cites/, () => J({ results: FX.OA_SEARCH.results.slice(2) })]);
    const r = await call(makeCtx(makeHub()), { op: "related", id: "1706.03762" });
    assert.equal(r.source, "OpenAlex");
    assert.equal(r.references.length, 2); assert.equal(r.cited_by.length, 1);
    assert.match(r.notes[0], /429/);
    assert.ok(calls.some(c => c.url.includes("10.48550/arxiv.1706.03762")));
  });
  test("both down, or Semantic Scholar id with no fallback: clear error", async () => {
    route([/semanticscholar/, () => J({}, 429)], [/openalex/, () => J({}, 429)]);
    const a = await call(makeCtx(makeHub()), { op: "related", id: "1706.03762" });
    assert.equal(a.ok, false); assert.match(a.error, /过几分钟/);
    route([/semanticscholar/, () => J({}, 429)]);
    const b = await call(makeCtx(makeHub()), { op: "related", id: "390623266fa8751198abc4edffa1878ab51311a9" });
    assert.equal(b.ok, false); assert.match(b.error, /稍后再试/);
    route([/semanticscholar/, () => J({}, 404)]);
    assert.match((await call(makeCtx(makeHub()), { op: "related", id: "10.1234/x" })).error, /没有这篇/);
  });
});

// ---------- daily cap, wiring ----------
describe("daily cap and wiring", () => {
  test("papers_daily caps every op; the refusal says so; nothing goes out", async () => {
    route(["export.arxiv.org", () => X(FX.ATOM_SEARCH)], ["semanticscholar.org", () => J(FX.SS_SEARCH)]);
    const ctx = makeCtx(makeHub(), { cap: 2 });
    assert.ok(!(await call(ctx, { op: "search", query: "beam" })).error);
    assert.ok(!(await call(ctx, { op: "search", query: "beam" })).error);
    const before = calls.length;
    const r = await call(ctx, { op: "search", query: "beam" });
    assert.equal(r.ok, false); assert.match(r.error, /用完了.*2 次/);
    assert.equal(calls.length, before);
    for (const op of ["get", "bibtex", "save", "related"]) assert.equal((await call(ctx, { op, id: "1706.03762", ids: ["1706.03762"] })).ok, false);
    assert.equal(calls.length, before);
  });
  test("cap 0 and unknown op", async () => {
    assert.equal((await call(makeCtx(makeHub(), { cap: 0 }), { op: "search", query: "x" })).ok, false);
    assert.equal((await call(makeCtx(makeHub()), { op: "frobnicate" })).ok, false);
  });
  test("an unexpected throw inside an op becomes a plain error, not an exception", async () => {
    route(["export.arxiv.org", () => { throw new Error("boom"); }]);
    const r = await call(makeCtx(makeHub()), { op: "get", id: "1706.03762" });
    assert.equal(r.ok, false);
  });
  test("feature surface: tool shape, tunable, Chinese about, description carries the rules", () => {
    const t = toolOf(makeCtx(makeHub()));
    assert.equal(t.name, "papers"); assert.equal(t.work, true);
    assert.deepEqual(t.parameters.properties.op.enum, ["search", "get", "bibtex", "save", "related"]);
    assert.deepEqual(t.parameters.properties.source.enum, ["auto", "arxiv", "semantic", "openalex"]);
    assert.deepEqual(t.parameters.properties.sort.enum, ["relevance", "recent", "cited"]);
    for (const w of ["先 op=search", "不要凭记忆", "id", "op=bibtex", "不要手写"]) assert.ok(t.description.includes(w), w);
    assert.equal(feature.tunables.papers_daily.default, 80);
    assert.ok(feature.about.length >= 4 && feature.about.every(l => /[一-鿿]/.test(l)));
  });
});
