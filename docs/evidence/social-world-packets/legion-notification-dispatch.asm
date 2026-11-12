
/home/kaloyan/work/re/WoW/artifacts/clients/7.3.5.26972/analysis-x64/Wow-64.analysis.exe:     file format pei-x86-64


Disassembly of section .text:

00000001411fe870 <.text+0x11fd870>:
   1411fe870:	48 89 5c 24 08       	mov    QWORD PTR [rsp+0x8],rbx
   1411fe875:	57                   	push   rdi
   1411fe876:	48 83 ec 20          	sub    rsp,0x20
   1411fe87a:	4c 8b 59 08          	mov    r11,QWORD PTR [rcx+0x8]
   1411fe87e:	49 8b d9             	mov    rbx,r9
   1411fe881:	49 8b f8             	mov    rdi,r8
   1411fe884:	4c 8b d2             	mov    r10,rdx
   1411fe887:	4c 8b c9             	mov    r9,rcx
   1411fe88a:	4d 85 db             	test   r11,r11
   1411fe88d:	0f 84 88 00 00 00    	je     0x1411fe91b
   1411fe893:	48 8b c2             	mov    rax,rdx
   1411fe896:	48 b9 cd 8c 55 ed d7 	movabs rcx,0xff51afd7ed558ccd
   1411fe89d:	af 51 ff 
   1411fe8a0:	48 c1 e8 21          	shr    rax,0x21
   1411fe8a4:	48 33 c2             	xor    rax,rdx
   1411fe8a7:	48 0f af c1          	imul   rax,rcx
   1411fe8ab:	48 8b d0             	mov    rdx,rax
   1411fe8ae:	48 c1 ea 21          	shr    rdx,0x21
   1411fe8b2:	48 33 d0             	xor    rdx,rax
   1411fe8b5:	48 b8 53 ec 85 1a fe 	movabs rax,0xc4ceb9fe1a85ec53
   1411fe8bc:	b9 ce c4 
   1411fe8bf:	48 0f af d0          	imul   rdx,rax
   1411fe8c3:	49 8b 01             	mov    rax,QWORD PTR [r9]
   1411fe8c6:	48 ff c8             	dec    rax
   1411fe8c9:	48 8b ca             	mov    rcx,rdx
   1411fe8cc:	48 c1 e9 21          	shr    rcx,0x21
   1411fe8d0:	48 33 ca             	xor    rcx,rdx
   1411fe8d3:	48 23 c8             	and    rcx,rax
   1411fe8d6:	49 8b 04 cb          	mov    rax,QWORD PTR [r11+rcx*8]
   1411fe8da:	49 8d 14 cb          	lea    rdx,[r11+rcx*8]
   1411fe8de:	48 85 c0             	test   rax,rax
   1411fe8e1:	74 11                	je     0x1411fe8f4
   1411fe8e3:	4c 3b 50 08          	cmp    r10,QWORD PTR [rax+0x8]
   1411fe8e7:	74 0b                	je     0x1411fe8f4
   1411fe8e9:	48 8b d0             	mov    rdx,rax
   1411fe8ec:	48 8b 00             	mov    rax,QWORD PTR [rax]
   1411fe8ef:	48 85 c0             	test   rax,rax
   1411fe8f2:	75 ef                	jne    0x1411fe8e3
   1411fe8f4:	48 8b 0a             	mov    rcx,QWORD PTR [rdx]
   1411fe8f7:	48 85 c9             	test   rcx,rcx
   1411fe8fa:	74 1f                	je     0x1411fe91b
   1411fe8fc:	48 8b 49 10          	mov    rcx,QWORD PTR [rcx+0x10]
   1411fe900:	49 83 c1 40          	add    r9,0x40
   1411fe904:	4c 8b c3             	mov    r8,rbx
   1411fe907:	48 8b 01             	mov    rax,QWORD PTR [rcx]
   1411fe90a:	48 8b d7             	mov    rdx,rdi
   1411fe90d:	48 8b 5c 24 30       	mov    rbx,QWORD PTR [rsp+0x30]
   1411fe912:	48 83 c4 20          	add    rsp,0x20
   1411fe916:	5f                   	pop    rdi
   1411fe917:	48 ff 60 08          	rex.W jmp QWORD PTR [rax+0x8]
   1411fe91b:	b8 40 01 00 80       	mov    eax,0x80000140
   1411fe920:	48 8b 5c 24 30       	mov    rbx,QWORD PTR [rsp+0x30]
   1411fe925:	48 83 c4 20          	add    rsp,0x20
   1411fe929:	5f                   	pop    rdi
   1411fe92a:	c3                   	ret
   1411fe92b:	5d                   	pop    rbp
   1411fe92c:	8c                   	.byte 0x8c
   1411fe92d:	bf                   	.byte 0xbf
   1411fe92e:	fe                   	(bad)
   1411fe92f:	f2                   	repnz
